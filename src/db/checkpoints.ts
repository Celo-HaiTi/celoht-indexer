import { getServiceRoleClient } from "@/db/supabaseClient";
import type { IndexTargetName } from "@/config/network";
import { ensureCanonicalContract, rollbackCanonical, updateCanonicalProgress } from "@/db/canonical";

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
  });
  const supabase = getServiceRoleClient();
  const { data, error } = await supabase
    .from("indexer_state")
    .select("id")
    .eq("chain_id", params.chainId)
    .eq("contract_address", params.contractAddress)
    .maybeSingle();
  if (error) throw error;
  if (data) return;

  const { error: insertError } = await supabase.from("indexer_state").insert({
    chain_id: params.chainId,
    contract_name: params.displayName,
    contract_address: params.contractAddress,
    last_processed_block: Math.max(0, Math.max(params.deploymentBlock, params.startBlock ?? params.deploymentBlock) - 1),
    sync_status: "idle",
  });
  if (insertError) throw insertError;
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
}): Promise<void> {
  const supabase = getServiceRoleClient();
  const { error } = await supabase
    .from("indexer_state")
    .update({
      last_processed_block: params.lastProcessedBlock.toString(),
      latest_confirmed_block: params.latestConfirmedBlock.toString(),
      sync_status: "syncing",
      last_successful_sync_at: new Date().toISOString(),
      last_error: null,
    })
    .eq("chain_id", params.chainId)
    .eq("contract_address", params.contractAddress);
  if (error) throw error;
  await updateCanonicalProgress(params);
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

/**
 * Rolls a checkpoint back to `safeBlock` (used during reorg recovery), and
 * deletes any blockchain_transactions rows for this contract at or above
 * the invalidated block so they can be safely re-indexed from the new
 * canonical chain.
 */
export async function rollbackCheckpoint(params: {
  chainId: number;
  contractAddress: string;
  safeBlock: bigint;
}): Promise<void> {
  const supabase = getServiceRoleClient();

  const { error: deleteError } = await supabase
    .from("blockchain_transactions")
    .delete()
    .eq("chain_id", params.chainId)
    .eq("contract_address", params.contractAddress)
    .gt("block_number", params.safeBlock.toString());
  if (deleteError) throw deleteError;
  const { error: tokenError } = await supabase
    .from("token_transfers")
    .delete()
    .eq("chain_id", params.chainId)
    .gt("block_number", params.safeBlock.toString());
  if (tokenError) throw tokenError;
  for (const table of ["agent_events", "service_payment_events", "education_events", "reforestation_events", "governance_events"]) {
    const { error } = await supabase.from(table).delete().eq("chain_id", params.chainId).gt("block_number", params.safeBlock.toString());
    if (error) throw error;
  }
  const { error: blocksError } = await supabase
    .from("indexed_blocks")
    .delete()
    .eq("chain_id", params.chainId)
    .gt("block_number", params.safeBlock.toString());
  if (blocksError) throw blocksError;
  await rollbackCanonical(params);

  const { error: updateError } = await supabase
    .from("indexer_state")
    .update({ last_processed_block: params.safeBlock.toString(), sync_status: "syncing" })
    .eq("chain_id", params.chainId)
    .eq("contract_address", params.contractAddress);
  if (updateError) throw updateError;
}
