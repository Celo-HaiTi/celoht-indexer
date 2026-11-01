import { getServiceRoleClient } from "@/db/supabaseClient";
import type { IndexTargetName } from "@/config/network";
import { ensureCanonicalContract, rollbackCanonical } from "@/db/canonical";
import { throwSupabaseError } from "@/db/supabaseDiagnostics";

export interface CheckpointRow {
  chainId: number;
  contractAddress: string;
  lastProcessedBlock: bigint;
  latestConfirmedBlock: bigint | null;
  syncStatus: "idle" | "syncing" | "error";
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
    deploymentTxHash: params.deploymentTxHash,
  });
  const supabase = getServiceRoleClient();
  const { error: insertError } = await supabase.from("indexer_state").insert({
    chain_id: params.chainId,
    contract_name: params.displayName,
    contract_address: params.contractAddress,
    last_processed_block: Math.max(0, Math.max(params.deploymentBlock, params.startBlock ?? params.deploymentBlock) - 1),
    sync_status: "idle",
  });
  if (insertError && insertError.code !== "23505") throwSupabaseError("indexer_state.insert", insertError);
}

export async function getCheckpoint(chainId: number, contractAddress: string): Promise<CheckpointRow> {
  const supabase = getServiceRoleClient();
  const { data, error } = await supabase
    .from("indexer_state")
    .select("chain_id, contract_address, last_processed_block, latest_confirmed_block, sync_status")
    .eq("chain_id", chainId)
    .eq("contract_address", contractAddress)
    .single();
  if (error) throw error;

  return {
    chainId: data.chain_id,
    contractAddress: data.contract_address,
    lastProcessedBlock: BigInt(data.last_processed_block),
    latestConfirmedBlock: data.latest_confirmed_block !== null ? BigInt(data.latest_confirmed_block) : null,
    syncStatus: data.sync_status,
  };
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
