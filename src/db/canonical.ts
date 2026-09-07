import type { DecodedEvent } from "@/indexing/eventDecoder";
import type { IndexTargetName } from "@/config/network";
import { getServiceRoleClient } from "@/db/supabaseClient";

const METADATA_REF = "Celo-HaiTi/celoht-smart-contracts/deployments/celoSepolia.json";

export async function persistCanonicalEvent(event: DecodedEvent, contract: IndexTargetName): Promise<void> {
  const supabase = getServiceRoleClient();
  const { data: contractRow, error: contractError } = await supabase
    .from("contracts")
    .select("id")
    .eq("chain_id", event.chainId)
    .eq("contract_address", event.contractAddress)
    .single();
  if (contractError) throw contractError;

  const { error: blockError } = await supabase.from("indexed_blocks").upsert(
    {
      chain_id: event.chainId,
      block_number: event.blockNumber.toString(),
      block_hash: event.blockHash,
      parent_hash: event.parentHash,
      block_time: event.blockTimestamp === null ? null : new Date(Number(event.blockTimestamp) * 1000).toISOString(),
      confirmed_at: new Date().toISOString(),
    },
    { onConflict: "chain_id,block_number" }
  );
  if (blockError) throw blockError;

  const { data: transaction, error: transactionError } = await supabase
    .from("indexed_transactions")
    .upsert(
      {
        chain_id: event.chainId,
        transaction_hash: event.transactionHash,
        block_number: event.blockNumber.toString(),
        block_hash: event.blockHash,
        transaction_index: event.transactionIndex,
        confirmation_status: "confirmed",
      },
      { onConflict: "chain_id,transaction_hash" }
    )
    .select("id")
    .single();
  if (transactionError) throw transactionError;

  const { error: eventError } = await supabase.from("blockchain_events").upsert(
    {
      chain_id: event.chainId,
      contract_id: contractRow.id,
      transaction_id: transaction.id,
      block_number: event.blockNumber.toString(),
      block_hash: event.blockHash,
      transaction_hash: event.transactionHash,
      transaction_index: event.transactionIndex,
      log_index: event.logIndex,
      event_name: event.eventName,
      event_type: contract,
      event_data: {
        ...serializeArgs(event.args),
        _provenance: { transactionIndex: event.transactionIndex },
      },
      confirmation_status: "confirmed",
      block_timestamp: event.blockTimestamp === null ? null : new Date(Number(event.blockTimestamp) * 1000).toISOString(),
    },
    { onConflict: "chain_id,transaction_hash,log_index" }
  );
  if (eventError) throw eventError;
}

export async function persistIndexedBlock(params: {
  chainId: number;
  blockNumber: bigint;
  blockHash: string | null;
  parentHash: string | null;
  blockTimestamp: bigint;
}): Promise<void> {
  if (!params.blockHash) throw new Error(`RPC returned no hash for block ${params.blockNumber}`);
  const { error } = await getServiceRoleClient().from("indexed_blocks").upsert(
    {
      chain_id: params.chainId,
      block_number: params.blockNumber.toString(),
      block_hash: params.blockHash,
      parent_hash: params.parentHash,
      block_time: new Date(Number(params.blockTimestamp) * 1000).toISOString(),
      confirmed_at: new Date().toISOString(),
    },
    { onConflict: "chain_id,block_number" }
  );
  if (error) throw error;
}

export async function ensureCanonicalContract(params: {
  chainId: number;
  network: string;
  contractName: string;
  contractAddress: string;
  deploymentBlock: number;
}): Promise<void> {
  const supabase = getServiceRoleClient();
  const { error: networkError } = await supabase.from("blockchain_networks").upsert(
    { chain_id: params.chainId, network: params.network, native_symbol: "CELO", is_enabled: params.network === "celoSepolia" },
    { onConflict: "chain_id" }
  );
  if (networkError) throw networkError;

  const { data: contract, error: contractError } = await supabase.from("contracts").upsert(
    {
      chain_id: params.chainId,
      contract_name: params.contractName,
      contract_address: params.contractAddress,
      deployment_block: params.deploymentBlock,
      metadata_ref: METADATA_REF,
      is_active: true,
    },
    { onConflict: "chain_id,contract_address" }
  ).select("id").single();
  if (contractError) throw contractError;

  const { data: existingState, error: readStateError } = await supabase
    .from("indexer_sync_state")
    .select("chain_id")
    .eq("chain_id", params.chainId)
    .eq("contract_id", contract.id)
    .maybeSingle();
  if (readStateError) throw readStateError;
  if (!existingState) {
    const { error: stateError } = await supabase.from("indexer_sync_state").insert({
      chain_id: params.chainId,
      contract_id: contract.id,
      next_block: params.deploymentBlock,
      status: "idle",
    });
    if (stateError) throw stateError;
  }
}

export async function updateCanonicalProgress(params: {
  chainId: number;
  contractAddress: string;
  lastProcessedBlock: bigint;
  latestConfirmedBlock: bigint;
}): Promise<void> {
  const supabase = getServiceRoleClient();
  const { data: contract, error: contractError } = await supabase
    .from("contracts")
    .select("id")
    .eq("chain_id", params.chainId)
    .eq("contract_address", params.contractAddress)
    .single();
  if (contractError) throw contractError;
  const { error } = await supabase.from("indexer_sync_state").update({
    next_block: (params.lastProcessedBlock + 1n).toString(),
    latest_confirmed_block: params.latestConfirmedBlock.toString(),
    status: "idle",
    last_success_at: new Date().toISOString(),
    last_error: null,
  }).eq("chain_id", params.chainId).eq("contract_id", contract.id);
  if (error) throw error;
}

export async function rollbackCanonical(params: {
  chainId: number;
  contractAddress: string;
  safeBlock: bigint;
}): Promise<void> {
  const supabase = getServiceRoleClient();
  const { data: contract, error: contractError } = await supabase
    .from("contracts")
    .select("id")
    .eq("chain_id", params.chainId)
    .eq("contract_address", params.contractAddress)
    .single();
  if (contractError) throw contractError;

  const { error: eventError } = await supabase
    .from("blockchain_events")
    .delete()
    .eq("chain_id", params.chainId)
    .eq("contract_id", contract.id)
    .gt("block_number", params.safeBlock.toString());
  if (eventError) throw eventError;

  const { error: stateError } = await supabase
    .from("indexer_sync_state")
    .update({ next_block: (params.safeBlock + 1n).toString(), status: "syncing" })
    .eq("chain_id", params.chainId)
    .eq("contract_id", contract.id);
  if (stateError) throw stateError;
}

function serializeArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).map(([key, value]) => [key, serializeValue(value)]));
}

function serializeValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(serializeValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, serializeValue(nested)]));
  return value;
}