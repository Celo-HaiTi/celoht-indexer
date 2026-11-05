# Database Contract

`migrations/001_indexer_schema.sql` owns the indexer ledger and checkpoint
tables. Apply migrations `002` and `003` after it. These migrations do not
create every shared application table used by optional projections; those must
come from the reviewed canonical migrations in `Celo-HaiTi/celoht-supabase`.

The runtime writes the following tables:

| Table | Use |
|---|---|
| `blockchain_networks`, `contracts` | Manifest-derived network and contract metadata |
| `indexer_state`, `indexer_sync_state` | Compatibility and canonical restart checkpoints |
| `indexed_blocks`, `indexed_transactions`, `blockchain_events` | Canonical block, transaction, and decoded event ledger |
| `blockchain_transactions` | Compatibility event projection, upserted by chain, transaction hash, and log index |
| `system_health` | Startup health snapshot; shared table required by the Supabase project |
| `agents` | Updates `on_chain_registry_status` for an existing wallet after `AgentRegistered`; never inserts an agent |
| `governance_proposals`, `governance_activity` | Optional governance projections for proposal and vote events |

`agents`, `governance_proposals`, and `governance_activity` are not created by
the local indexer migrations. Confirm their columns, unique constraints, and
service-role grants against the deployed canonical Supabase schema before
enabling these projections. The indexer logs unsupported event projections
for service payments, education, reforestation, and USDm; their decoded events
remain available in `blockchain_events`.

The indexer does not write to user profiles, KYC, courses, lessons, learning
progress, certificates, reforestation project/evidence records, or audit logs.
The `SUPABASE_SERVICE_ROLE_KEY` is server-side only.
