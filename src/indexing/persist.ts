import { getServiceRoleClient } from "@/db/supabaseClient";
import type { DecodedEvent } from "@/indexing/eventDecoder";
import type { IndexTargetName } from "@/config/network";
import { logger } from "@/util/logger";
import { persistCanonicalEvent } from "@/db/canonical";

/** Persist the lossless decoded event before any optional projections. */
export async function persistEvent(event: DecodedEvent, contract: IndexTargetName): Promise<void> {
  const { data: row, error } = await getServiceRoleClient()
    .from("blockchain_transactions")
    .upsert(
      {
        chain_id: event.chainId,
        contract_address: event.contractAddress,
        transaction_hash: event.transactionHash,
        log_index: event.logIndex,
        block_number: event.blockNumber.toString(),
        block_hash: event.blockHash,
        transaction_index: event.transactionIndex,
        event_name: event.eventName,
        event_data: {
          ...serializeArgs(event.args),
          _provenance: { transactionIndex: event.transactionIndex },
        },
        confirmed: true,
      },
      { onConflict: "chain_id,transaction_hash,log_index" }
    )
    .select("id")
    .single();

  if (error) throw error;
  if (!row) throw new Error("Supabase did not return the persisted event id");
  await persistCanonicalEvent(event, contract);
  await persistDomainEvent(event, contract);

  if (contract === "usdm" && event.eventName === "Transfer") {
    await persistTokenTransfer(row.id, event);
  }
  if (contract === "agentRegistry") await persistAgentRegistration(event);
  if (contract === "governance") await persistGovernance(row.id, event);
  if (contract === "servicePayments" || contract === "reforestation") {
    logger.info("legacy_projection_skipped", {
      contract,
      event: event.eventName,
      reason: "verified event does not contain all legacy projection fields",
    });
  }
}

async function persistDomainEvent(event: DecodedEvent, contract: IndexTargetName): Promise<void> {
  const tableByContract: Partial<Record<IndexTargetName, string>> = {
    agentRegistry: "agent_events",
    servicePayments: "service_payment_events",
    education: "education_events",
    reforestation: "reforestation_events",
    governance: "governance_events",
  };
  const table = tableByContract[contract];
  if (!table) return;

  const supabase = getServiceRoleClient();
  const [{ data: contractRow, error: contractError }, { data: transaction, error: transactionError }] = await Promise.all([
    supabase.from("contracts").select("id").eq("chain_id", event.chainId).eq("contract_address", event.contractAddress).single(),
    supabase.from("indexed_transactions").select("id").eq("chain_id", event.chainId).eq("transaction_hash", event.transactionHash).single(),
  ]);
  if (contractError) throw contractError;
  if (transactionError) throw transactionError;

  const { error } = await supabase.from(table).upsert(
    {
      chain_id: event.chainId,
      contract_id: contractRow.id,
      transaction_id: transaction.id,
      block_number: event.blockNumber.toString(),
      block_hash: event.blockHash,
      parent_hash: event.parentHash,
      transaction_hash: event.transactionHash,
      transaction_index: event.transactionIndex,
      log_index: event.logIndex,
      contract_address: event.contractAddress,
      event_name: event.eventName,
      event_type: contract,
      block_timestamp: event.blockTimestamp === null ? null : new Date(Number(event.blockTimestamp) * 1000).toISOString(),
      event_data: serializeArgs(event.args),
      confirmation_status: "confirmed",
    },
    { onConflict: "chain_id,transaction_hash,log_index" }
  );
  if (error) throw error;
}

async function persistTokenTransfer(blockchainTransactionId: string, event: DecodedEvent): Promise<void> {
  const { from, to, value } = event.args;
  if (typeof from !== "string" || typeof to !== "string" || value === undefined) {
    logger.warn("token_transfer_missing_fields", { transactionHash: event.transactionHash });
    return;
  }
  const { error } = await getServiceRoleClient().from("token_transfers").upsert(
    {
      chain_id: event.chainId,
      token_address: event.contractAddress,
      blockchain_transaction_id: blockchainTransactionId,
      transaction_hash: event.transactionHash,
      log_index: event.logIndex,
      block_number: event.blockNumber.toString(),
      block_hash: event.blockHash,
      from_address: from.toLowerCase(),
      to_address: to.toLowerCase(),
      amount: String(value),
      asset_symbol: "USDm",
      confirmation_status: "confirmed",
    },
    { onConflict: "chain_id,transaction_hash,log_index" }
  );
  if (error) throw error;
}

function serializeArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => [key, serializeValue(value)])
  );
}

function serializeValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(serializeValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, serializeValue(nested)]));
  }
  return value;
}

async function persistAgentRegistration(event: DecodedEvent): Promise<void> {
  if (event.eventName !== "AgentRegistered") return;
  const wallet = event.args.wallet;
  if (typeof wallet !== "string") return;

  const { data, error } = await getServiceRoleClient()
    .from("agents")
    .update({ on_chain_registry_status: "registered" })
    .eq("wallet_address", wallet.toLowerCase())
    .select("id");
  if (error) throw error;
  if (!data?.length) {
    logger.warn("agent_registry_event_no_matching_agent", {
      wallet,
      event: event.eventName,
      transactionHash: event.transactionHash,
    });
  }
}

async function persistGovernance(blockchainTransactionId: string, event: DecodedEvent): Promise<void> {
  const supabase = getServiceRoleClient();
  if (event.eventName === "ProposalCreated") {
    const proposalId = event.args.proposalId;
    if (proposalId === undefined) return;
    const { error } = await supabase.from("governance_proposals").upsert(
      {
        on_chain_proposal_id: String(proposalId),
        blockchain_transaction_id: blockchainTransactionId,
        title: null,
        description: event.args.metadataURI === undefined ? null : String(event.args.metadataURI),
        status: "pending",
      },
      { onConflict: "on_chain_proposal_id" }
    );
    if (error) throw error;
    return;
  }

  if (event.eventName !== "VoteCast") return;
  const { proposalId, voter, option } = event.args;
  if (proposalId === undefined || typeof voter !== "string" || option === undefined) return;

  const { data: proposal, error: proposalError } = await supabase
    .from("governance_proposals")
    .select("id")
    .eq("on_chain_proposal_id", String(proposalId))
    .maybeSingle();
  if (proposalError) throw proposalError;
  if (!proposal) {
    logger.warn("vote_cast_unknown_proposal", {
      proposalId: String(proposalId),
      transactionHash: event.transactionHash,
    });
    return;
  }

  const { error } = await supabase.from("governance_activity").upsert(
    {
      proposal_id: proposal.id,
      blockchain_transaction_id: blockchainTransactionId,
      voter_wallet_address: voter,
      vote: mapVote(option),
    },
    { onConflict: "proposal_id,voter_wallet_address" }
  );
  if (error) throw error;
}

function mapVote(option: unknown): "for" | "against" | "abstain" {
  const normalized = String(option).toLowerCase();
  if (normalized === "1" || normalized === "yes") return "for";
  if (normalized === "2" || normalized === "no") return "against";
  return "abstain";
}
