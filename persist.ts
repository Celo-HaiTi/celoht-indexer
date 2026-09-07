import { getServiceRoleClient } from "@/db/supabaseClient";
import type { DecodedEvent } from "@/indexing/eventDecoder";
import type { ContractName } from "@/config/network";
import { logger } from "@/util/logger";

/**
 * IMPORTANT: The event/field names referenced below (e.g. "AgentRegistered",
 * "ProposalCreated", "VoteCast", and args like `agent`/`proposalId`/`voter`)
 * are placeholders based on the contract names in the master prompt. This
 * indexer was built without access to the real ABI files (see abis/README.md
 * for why). Before running against production, confirm every event name and
 * argument name below against the actual compiled ABI in
 * Celo-HaiTi/celoht-smart-contracts and update mapRegistryEventToStatus(),
 * persistGovernanceEvent(), persistAgentTransaction(), and
 * persistReforestationContribution() to match exactly. Any event name that
 * doesn't match is already handled safely — it is recorded verbatim in
 * blockchain_transactions and simply skipped by the derived-table logic
 * below (see the `default: return null` / early-return branches), so a
 * naming mismatch causes missing derived rows, never fabricated ones.
 */

/**
 * Persists one decoded event. Idempotency is enforced at the database layer
 * by the unique constraint on (chain_id, transaction_hash, log_index) in
 * blockchain_transactions (see celoht-supabase/migrations/0004_schema_onchain.sql),
 * so a re-run of the same block range or a crash-recovery restart cannot
 * create duplicates — this function upserts on that key.
 *
 * This function writes ONLY to tables documented as INDEXER OWNED in
 * celoht-supabase/docs/OWNERSHIP.md. It never touches profiles, agent_kyc,
 * courses, course_progress, certificates, reforestation_projects,
 * reforestation_evidence, or audit_logs.
 */
export async function persistEvent(event: DecodedEvent, contract: ContractName): Promise<void> {
  const supabase = getServiceRoleClient();

  const { data: txRow, error: txError } = await supabase
    .from("blockchain_transactions")
    .upsert(
      {
        chain_id: event.chainId,
        contract_address: event.contractAddress,
        transaction_hash: event.transactionHash,
        log_index: event.logIndex,
        block_number: event.blockNumber.toString(),
        block_hash: event.blockHash,
        event_name: event.eventName,
        event_data: serializeArgs(event.args),
        confirmed: true,
      },
      { onConflict: "chain_id,transaction_hash,log_index" }
    )
    .select("id")
    .single();

  if (txError) throw txError;

  switch (contract) {
    case "servicePayments":
      await persistAgentTransaction(txRow.id, event);
      break;
    case "reforestation":
      await persistReforestationContribution(txRow.id, event);
      break;
    case "governance":
      await persistGovernanceEvent(txRow.id, event);
      break;
    case "agentRegistry":
      await persistAgentRegistryEvent(event);
      break;
    case "education":
      // Education on-chain events (if any are emitted by the official
      // contract) are recorded generically in blockchain_transactions only.
      // No off-chain course completion is ever inferred from them.
      break;
  }
}

function serializeArgs(args: Record<string, unknown>): Record<string, unknown> {
  // bigint values from viem decoding are not JSON-serializable as-is.
  return Object.fromEntries(
    Object.entries(args).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v])
  );
}

async function persistAgentTransaction(blockchainTransactionId: string, event: DecodedEvent): Promise<void> {
  const supabase = getServiceRoleClient();
  const { agent, payer, recipient, asset, amount } = event.args as Record<string, unknown>;

  if (!agent || !payer || !recipient || !asset || amount === undefined) {
    logger.warn("agent_transaction_missing_fields", { eventName: event.eventName, tx: event.transactionHash });
    return; // Do not fabricate missing fields; skip the derived row (the raw event is still recorded).
  }

  const { error } = await supabase.from("agent_transactions").upsert(
    {
      blockchain_transaction_id: blockchainTransactionId,
      agent_wallet_address: String(agent),
      payer_wallet_address: String(payer),
      recipient_wallet_address: String(recipient),
      asset_address: String(asset),
      amount: String(amount),
    },
    { onConflict: "blockchain_transaction_id" }
  );
  if (error) throw error;
}

async function persistReforestationContribution(blockchainTransactionId: string, event: DecodedEvent): Promise<void> {
  const supabase = getServiceRoleClient();
  const { contributor, asset, amount } = event.args as Record<string, unknown>;

  if (!contributor || !asset || amount === undefined) {
    logger.warn("reforestation_contribution_missing_fields", { eventName: event.eventName, tx: event.transactionHash });
    return;
  }

  // project_id is left null here — mapping an on-chain contribution to a
  // catalog project (if the event doesn't carry one) is a backend/admin
  // concern, never inferred by the indexer.
  const { error } = await supabase.from("reforestation_contributions").upsert(
    {
      blockchain_transaction_id: blockchainTransactionId,
      contributor_wallet_address: String(contributor),
      asset_address: String(asset),
      amount: String(amount),
    },
    { onConflict: "blockchain_transaction_id" }
  );
  if (error) throw error;
}

async function persistGovernanceEvent(blockchainTransactionId: string, event: DecodedEvent): Promise<void> {
  const supabase = getServiceRoleClient();

  if (event.eventName === "ProposalCreated") {
    const { proposalId, title, description } = event.args as Record<string, unknown>;
    if (proposalId === undefined) return;

    const { error } = await supabase.from("governance_proposals").upsert(
      {
        on_chain_proposal_id: String(proposalId),
        blockchain_transaction_id: blockchainTransactionId,
        title: title !== undefined ? String(title) : null,
        description: description !== undefined ? String(description) : null,
        status: "active",
      },
      { onConflict: "on_chain_proposal_id" }
    );
    if (error) throw error;
    return;
  }

  if (event.eventName === "VoteCast") {
    const { proposalId, voter, support } = event.args as Record<string, unknown>;
    if (proposalId === undefined || !voter || support === undefined) {
      logger.warn("vote_cast_missing_fields", { tx: event.transactionHash });
      return;
    }

    const { data: proposal, error: proposalError } = await supabase
      .from("governance_proposals")
      .select("id")
      .eq("on_chain_proposal_id", String(proposalId))
      .maybeSingle();
    if (proposalError) throw proposalError;
    if (!proposal) {
      logger.warn("vote_cast_unknown_proposal", { proposalId: String(proposalId), tx: event.transactionHash });
      return;
    }

    // CeloHT governance is strictly 1 wallet = 1 vote — no token weighting
    // is computed or stored anywhere in this function.
    const vote = mapSupportToVote(support);
    const { error } = await supabase.from("governance_activity").upsert(
      {
        proposal_id: proposal.id,
        blockchain_transaction_id: blockchainTransactionId,
        voter_wallet_address: String(voter),
        vote,
      },
      { onConflict: "proposal_id,voter_wallet_address" }
    );
    if (error) throw error;
  }

  // Any other governance event name (e.g. an execution-related event) is
  // still recorded verbatim in blockchain_transactions above, but this
  // indexer does not synthesize an "executed" state from it — advisory
  // governance never implies automatic Treasury execution.
}

function mapSupportToVote(support: unknown): "for" | "against" | "abstain" {
  const normalized = String(support).toLowerCase();
  if (normalized === "1" || normalized === "for" || normalized === "true") return "for";
  if (normalized === "0" || normalized === "against" || normalized === "false") return "against";
  return "abstain";
}

async function persistAgentRegistryEvent(event: DecodedEvent): Promise<void> {
  const supabase = getServiceRoleClient();
  const { agent } = event.args as Record<string, unknown>;
  if (!agent) return;

  const nextStatus = mapRegistryEventToStatus(event.eventName);
  if (!nextStatus) return; // Unrecognized event name for this contract — record raw only, don't guess a status.

  // Update-only: never insert a new `agents` row here. If no off-chain
  // application exists yet for this wallet, that is an operational signal
  // (an on-chain registration with no matching application), not something
  // this indexer resolves by fabricating a profile/agent record.
  const { error, count } = await supabase
    .from("agents")
    .update({ on_chain_registry_status: nextStatus })
    .eq("wallet_address", String(agent).toLowerCase())
    .select("id", { count: "exact" });

  if (error) throw error;
  if (!count) {
    logger.warn("agent_registry_event_no_matching_agent", {
      wallet: String(agent),
      eventName: event.eventName,
      tx: event.transactionHash,
    });
  }
}

function mapRegistryEventToStatus(eventName: string): "registered" | "suspended" | "revoked" | null {
  switch (eventName) {
    case "AgentRegistered":
      return "registered";
    case "AgentSuspended":
      return "suspended";
    case "AgentRevoked":
      return "revoked";
    default:
      return null;
  }
}
