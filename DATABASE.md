# DATABASE.md (indexer perspective)

Schema lives in `Celo-HaiTi/celoht-supabase`. This indexer writes exclusively to
the tables documented there as INDEXER OWNED or explicitly shared:

- `blockchain_transactions` (upsert, unique on chain_id/tx_hash/log_index)
- `governance_proposals`, `governance_activity` (upsert, keyed as described in
  the canonical migration)
- `indexer_state` (checkpoints)
- `agents.on_chain_registry_status` — **update only**, matched by
  wallet_address; never inserts a new `agents` row
- `system_health` (component = 'indexer', shared health snapshot)

The authoritative event ledger is `blockchain_events`. The indexer does not
write local-only event tables such as `agent_events`,
`service_payment_events`, `education_events`, `reforestation_events`,
`governance_events`, or `token_transfers`; those tables are not part of the
canonical Supabase contract.

It never writes to `profiles`, `agent_kyc`, `courses`, `course_modules`,
`lessons`, `course_progress`, `certificates`, `reforestation_projects`,
`reforestation_evidence`, or `audit_logs` — see `src/indexing/persist.ts`,
which only imports the service-role client and only touches the tables
listed above.
