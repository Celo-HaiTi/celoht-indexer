import { getServiceRoleClient } from "@/db/supabaseClient";
import type { IndexTargetName } from "@/config/network";
import { ensureCanonicalContract, rollbackCanonical } from "@/db/canonical";
import { throwSupabaseError } from "@/db/supabaseDiagnostics";
import type { PublicClient } from "viem";
import { classifyRpcError, withRetry } from "@/chain/retry";
import { logger } from "@/util/logger";
import { serializeError } from "@/util/errorSerializer";

export interface CheckpointRow {
  chainId: number;
  contractAddress: string;
  lastProcessedBlock: bigint | null;
  nextBlock: bigint;
  lastProcessedBlockHash: string | null;
  lastProcessedParentHash: string | null;
  latestConfirmedBlock: bigint | null;
  syncStatus: "idle" | "syncing" | "error";
}

export class CheckpointConsistencyError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CheckpointConsistencyError";
  }
}

export class CheckpointRecoveryRequiredError extends CheckpointConsistencyError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CheckpointRecoveryRequiredError";
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
    last_processed_block: Math.max(0, initialBlock - 1),
    sync_status: "idle",
  });
  if (insertError && insertError.code !== "23505") throwSupabaseError("indexer_state.insert", insertError);
}

export async function getCheckpoint(params: {
  chainId: number;
  contractAddress: string;
  client: PublicClient;
  initialBlock: number;
  maxRetries?: number;
}): Promise<CheckpointRow> {
  if (!Number.isSafeInteger(params.initialBlock) || params.initialBlock < 0) {
    throw new RangeError("initialBlock must be a nonnegative safe integer");
  }
  const supabase = getServiceRoleClient();
  const { data: contract, error: contractError } = await supabase
    .from("contracts")
    .select("id")
    .eq("chain_id", params.chainId)
    .eq("contract_address", params.contractAddress)
    .single();
  if (contractError) throw contractError;

  const { data: legacy, error: legacyError } = await supabase
    .from("indexer_state")
    .select("chain_id, contract_address, last_processed_block, latest_confirmed_block, sync_status")
    .eq("chain_id", params.chainId)
    .eq("contract_address", params.contractAddress)
    .single();
  if (legacyError) throw legacyError;

  const { data: canonical, error: canonicalError } = await supabase
    .from("indexer_sync_state")
    .select("next_block, last_processed_block, last_processed_block_hash, last_processed_parent_hash, latest_confirmed_block")
    .eq("chain_id", params.chainId)
    .eq("contract_id", contract.id)
    .single();
  if (canonicalError) throw canonicalError;

  const legacyProcessedBlock = BigInt(legacy.last_processed_block);
  const canonicalProcessedBlock = BigInt(canonical.last_processed_block);
  const nextBlock = BigInt(canonical.next_block);
  const latestConfirmedBlock = nullableBigInt(legacy.latest_confirmed_block);
  const canonicalLatestConfirmedBlock = nullableBigInt(canonical.latest_confirmed_block);
  const initialBlock = BigInt(params.initialBlock);
  const expectedLegacySeed = initialBlock > 0n ? initialBlock - 1n : 0n;
  const uninitializedAtStart =
    nextBlock === initialBlock &&
    (canonicalProcessedBlock === 0n || canonicalProcessedBlock === expectedLegacySeed) &&
    legacyProcessedBlock === expectedLegacySeed &&
    canonical.last_processed_block_hash === null && canonical.last_processed_parent_hash === null &&
    latestConfirmedBlock === null && canonicalLatestConfirmedBlock === null;

  if (uninitializedAtStart) {
    return {
      chainId: legacy.chain_id,
      contractAddress: legacy.contract_address,
      lastProcessedBlock: null,
      nextBlock,
      lastProcessedBlockHash: null,
      lastProcessedParentHash: null,
      latestConfirmedBlock: null,
      syncStatus: legacy.sync_status,
    };
  }

  if (
    legacyProcessedBlock !== canonicalProcessedBlock ||
    latestConfirmedBlock !== canonicalLatestConfirmedBlock ||
    nextBlock !== canonicalProcessedBlock + 1n
  ) {
    throw new CheckpointRecoveryRequiredError(
      `Checkpoint ledgers disagree for chain ${params.chainId}, contract ${params.contractAddress}: ` +
        `indexer_state=${legacy.last_processed_block}/${legacy.latest_confirmed_block}, ` +
        `indexer_sync_state=${canonical.last_processed_block}/${canonical.latest_confirmed_block}/next=${canonical.next_block}.`
    );
  }

  const checkpointHash = canonical.last_processed_block_hash;
  if (typeof checkpointHash !== "string" || !isHash(checkpointHash)) {
    throw new CheckpointRecoveryRequiredError(
      `Checkpoint hash is missing or malformed at block ${canonicalProcessedBlock} for ${params.contractAddress}.`
    );
  }

  const { data: anchor, error: anchorError } = await supabase
    .from("indexed_blocks")
    .select("block_number, block_hash, parent_hash, confirmation_status")
    .eq("chain_id", params.chainId)
    .eq("block_number", canonicalProcessedBlock.toString())
    .eq("block_hash", checkpointHash)
    .in("confirmation_status", ["canonical", "confirmed"])
    .maybeSingle();
  if (anchorError) {
    throw new CheckpointRecoveryRequiredError(
      `Could not verify indexed_blocks anchor at ${canonicalProcessedBlock}: ${String(anchorError)}`
    );
  }
  if (!anchor || BigInt(anchor.block_number) !== canonicalProcessedBlock || !isHash(anchor.block_hash)) {
    throw new CheckpointRecoveryRequiredError(
      `No eligible indexed_blocks anchor matches checkpoint ${canonicalProcessedBlock} for ${params.contractAddress}.`
    );
  }

  let rpcBlock;
  try {
    rpcBlock = await withRetry(
      () => params.client.getBlock({ blockNumber: canonicalProcessedBlock }),
      {
        maxRetries: params.maxRetries ?? 0,
        label: `archive.getBlock(${canonicalProcessedBlock})`,
        endpointRole: "archive",
        requestedBlock: canonicalProcessedBlock.toString(),
      }
    );
  } catch (error) {
    logger.error("checkpoint_rpc_verification_failed", {
      endpointRole: "archive",
      requestedBlock: canonicalProcessedBlock.toString(),
      errorCategory: classifyRpcError(error),
      error: serializeError(error),
    });
    throw new CheckpointRecoveryRequiredError(
      `RPC could not verify checkpoint ${canonicalProcessedBlock} for ${params.contractAddress} (${classifyRpcError(error)}).`,
      { cause: error }
    );
  }
  if (
    !rpcBlock || rpcBlock.number !== canonicalProcessedBlock || typeof rpcBlock.hash !== "string" ||
    !isHash(rpcBlock.hash) || rpcBlock.hash.toLowerCase() !== checkpointHash.toLowerCase()
  ) {
    throw new CheckpointRecoveryRequiredError(
      `RPC hash does not verify checkpoint ${canonicalProcessedBlock} for ${params.contractAddress}.`
    );
  }
  if (
    (canonical.last_processed_parent_hash !== null &&
      (!isHash(canonical.last_processed_parent_hash) || canonical.last_processed_parent_hash.toLowerCase() !== rpcBlock.parentHash.toLowerCase())) ||
    (anchor.parent_hash !== null &&
      (!isHash(anchor.parent_hash) || anchor.parent_hash.toLowerCase() !== rpcBlock.parentHash.toLowerCase()))
  ) {
    throw new CheckpointRecoveryRequiredError(
      `RPC parent hash does not verify checkpoint ${canonicalProcessedBlock} for ${params.contractAddress}.`
    );
  }

  return {
    chainId: legacy.chain_id,
    contractAddress: legacy.contract_address,
    lastProcessedBlock: canonicalProcessedBlock,
    nextBlock,
    lastProcessedBlockHash: checkpointHash.toLowerCase(),
    lastProcessedParentHash: canonical.last_processed_parent_hash,
    latestConfirmedBlock: nullableBigInt(legacy.latest_confirmed_block),
    syncStatus: legacy.sync_status,
  };
}

function isHash(value: string): boolean {
  return /^0x[0-9a-f]{64}$/i.test(value);
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
  if (params.lastProcessedBlock < 0n || params.latestConfirmedBlock < 0n) {
    throw new RangeError("checkpoint block numbers must be nonnegative");
  }
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
  if (!Number.isSafeInteger(params.deploymentBlock) || params.deploymentBlock < 0) {
    throw new RangeError("deploymentBlock must be a nonnegative safe integer");
  }
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
  if (params.safeBlock < 0n) throw new RangeError("safeBlock must be nonnegative");

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
