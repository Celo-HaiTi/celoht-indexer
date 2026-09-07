# DATABASE.md (indexer perspective)

Schema lives in `celoht-supabase`. This indexer writes exclusively to the
tables documented there as INDEXER OWNED:

- `blockchain_transactions` (upsert, unique on chain_id/tx_hash/log_index)
- `agent_transactions`, `reforestation_contributions`,
  `governance_proposals`, `governance_activity` (upsert, keyed as described
  in each migration)
- `indexer_state` (checkpoints)
- `agents.on_chain_registry_status` — **update only**, matched by
  wallet_address; never inserts a new `agents` row
- `system_health` (component = 'indexer')

It never writes to `profiles`, `agent_kyc`, `courses`, `course_modules`,
`lessons`, `course_progress`, `certificates`, `reforestation_projects`,
`reforestation_evidence`, or `audit_logs` — see `src/indexing/persist.ts`,
which only imports the service-role client and only touches the tables
listed above.
