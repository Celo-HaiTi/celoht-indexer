import { getServiceRoleClient } from "@/db/supabaseClient";
import type { IndexTargetName } from "@/config/network";
import { ensureCanonicalContract, rollbackCanonical } from "@/db/canonical";
import { throwSupabaseError } from "@/db/supabaseDiagnostics";

export interface CheckpointRow {
  chainId: number;
  contractAddress: string;
  lastProcessedBlock: bigint;
  lastProcessedBlockHash: string | null;
  lastProcessedParentHash: string | null;
  latestConfirmedBlock: bigint | null;
  syncStatus: "idle" | "syncing" | "error";
}

export class CheckpointConsistencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckpointConsistencyError";
  }
}

/**
 * Ensures an indexer_state row exists for a contract, seeded at its official
 * deployment block if not already present. Idempotent — safe to call on
 * every startup.
 */
export async function ensureCheckpoint(params: {
  chainId: number;
  contractName: IndexTargetName;
  displayName: string;
  contractAddress: string;
  deploymentBlock: number;
  deploymentTxHash?: string;
  startBlock?: number;
  network?: string;
}): Promise<void> {
  if (params.startBlock !== undefined && params.startBlock < params.deploymentBlock) {
    throw new Error(
      `START_BLOCK ${params.startBlock} is before the verified deployment block ${params.deploymentBlock} for ${params.displayName}.`
    );
  }
  await ensureCanonicalContract({
    chainId: params.chainId,
    network: params.network ?? "celoSepolia",
    contractName: params.displayName,
    contractAddress: params.contractAddress,
    deploymentBlock: params.deploymentBlock,
    startBlock: params.startBlock,
    deploymentTxHash: params.deploymentTxHash,
  });
  const supabase = getServiceRoleClient();
  const initialBlock = Math.max(params.deploymentBlock, params.startBlock ?? params.deploymentBlock);
  const { error: insertError } = await supabase.from("indexer_state").insert({
    chain_id: params.chainId,
    contract_name: params.displayName,
    contract_address: params.contractAddress,
    last_processed_block: initialBlock - 1,
    sync_status: "idle",
  });
  if (insertError && insertError.code !== "23505") throwSupabaseError("indexer_state.insert", insertError);
}

export async function getCheckpoint(chainId: number, contractAddress: string): Promise<CheckpointRow> {
  const supabase = getServiceRoleClient();
  const { data: contract, error: contractError } = await supabase
    .from("contracts")
    .select("id")
    .eq("chain_id", chainId)
    .eq("contract_address", contractAddress)
    .single();
  if (contractError) throw contractError;

  const { data: legacy, error: legacyError } = await supabase
    .from("indexer_state")
    .select("chain_id, contract_address, last_processed_block, latest_confirmed_block, sync_status")
    .eq("chain_id", chainId)
    .eq("contract_address", contractAddress)
    .single();
  if (legacyError) throw legacyError;

  const { data: canonical, error: canonicalError } = await supabase
    .from("indexer_sync_state")
    .select("next_block, last_processed_block, last_processed_block_hash, last_processed_parent_hash, latest_confirmed_block")
    .eq("chain_id", chainId)
    .eq("contract_id", contract.id)
    .single();
  if (canonicalError) throw canonicalError;

  if (
    BigInt(legacy.last_processed_block) !== BigInt(canonical.last_processed_block) ||
    nullableBigInt(legacy.latest_confirmed_block) !== nullableBigInt(canonical.latest_confirmed_block) ||
    BigInt(canonical.next_block) !== BigInt(canonical.last_processed_block) + 1n
  ) {
    throw new CheckpointConsistencyError(
      `Checkpoint ledgers disagree for chain ${chainId}, contract ${contractAddress}: ` +
        `indexer_state=${legacy.last_processed_block}/${legacy.latest_confirmed_block}, ` +
        `indexer_sync_state=${canonical.last_processed_block}/${canonical.latest_confirmed_block}/next=${canonical.next_block}.`
    );
  }

  return {
    chainId: legacy.chain_id,
    contractAddress: legacy.contract_address,
    lastProcessedBlock: BigInt(legacy.last_processed_block),
    lastProcessedBlockHash: canonical.last_processed_block_hash,
    lastProcessedParentHash: canonical.last_processed_parent_hash,
    latestConfirmedBlock: nullableBigInt(legacy.latest_confirmed_block),
    syncStatus: legacy.sync_status,
  };
}

function nullableBigInt(value: string | number | null): bigint | null {
  return value === null ? null : BigInt(value);
}

export async function updateCheckpointProgress(params: {
  chainId: number;
  contractAddress: string;
  lastProcessedBlock: bigint;
  latestConfirmedBlock: bigint;
  blockHash: string;
  parentHash: string | null;
  blockTimestamp: bigint;
}): Promise<void> {
  const supabase = getServiceRoleClient();
  const { error } = await supabase.rpc("commit_indexer_checkpoint", {
    p_chain_id: params.chainId,
    p_contract_address: params.contractAddress,
    p_block_number: params.lastProcessedBlock.toString(),
    p_block_hash: params.blockHash,
    p_parent_hash: params.parentHash,
    p_block_time: new Date(Number(params.blockTimestamp) * 1000).toISOString(),
    p_latest_confirmed_block: params.latestConfirmedBlock.toString(),
  });
  if (error) throw error;
}

export async function rewindCheckpointToDeployment(params: {
  chainId: number;
  contractAddress: string;
  deploymentBlock: number;
}): Promise<void> {
  const { error } = await getServiceRoleClient().rpc("rewind_indexer_checkpoint_to_deployment", {
    p_chain_id: params.chainId,
    p_contract_address: params.contractAddress,
    p_deployment_block: params.deploymentBlock,
  });
  if (error) throw error;
}

export async function recordCheckpointError(params: {
  chainId: number;
  contractAddress: string;
  errorMessage: string;
}): Promise<void> {
  const supabase = getServiceRoleClient();
  const { error } = await supabase
    .from("indexer_state")
    .update({ sync_status: "error", last_error: params.errorMessage })
    .eq("chain_id", params.chainId)
    .eq("contract_address", params.contractAddress);
  if (error) throw error;
}

/** Rolls chain-wide checkpoints back while retaining invalidated observations for reorg audit. */
export async function rollbackCheckpoint(params: {
  chainId: number;
  safeBlock: bigint;
  safeBlockHash: string;
  safeParentHash: string | null;
}): Promise<void> {
  const supabase = getServiceRoleClient();

  const { error: compatibilityError } = await supabase
    .from("blockchain_transactions")
    .update({ confirmed: false })
    .eq("chain_id", params.chainId)
    .gt("block_number", params.safeBlock.toString());
  if (compatibilityError) throw compatibilityError;
  await rollbackCanonical({
    chainId: params.chainId,
    safeBlock: params.safeBlock,
    safeBlockHash: params.safeBlockHash,
    safeParentHash: params.safeParentHash,
  });

  const { error: updateError } = await supabase
    .from("indexer_state")
    .update({
      last_processed_block: params.safeBlock.toString(),
      latest_confirmed_block: null,
      sync_status: "syncing",
      last_error: null,
    })
    .eq("chain_id", params.chainId)
    .gt("last_processed_block", params.safeBlock.toString());
  if (updateError) throw updateError;
}
