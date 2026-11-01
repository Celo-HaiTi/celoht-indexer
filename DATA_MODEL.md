# Data Model

The migration in `migrations/001_indexer_schema.sql` is the indexer-owned Postgres contract.

`indexed_blocks` stores canonical block number, hash, parent hash, timestamp, and confirmation time. `indexed_transactions` stores transaction hash, block provenance, transaction index, and confirmation state. `blockchain_events` is the lossless decoded ledger; its unique key is `(chain_id, transaction_hash, log_index)` and `event_data` retains serialized ABI arguments.
`indexed_blocks` retains block observations by `(chain_id, block_number, block_hash)`. Its `confirmation_status` is `canonical`, `confirmed`, or `orphaned`; the database permits only one canonical/confirmed observation per height while retaining orphaned history. `indexed_transactions` stores transaction hash, block provenance, transaction index, and confirmation state. `blockchain_events` is the lossless decoded ledger; its unique key is `(chain_id, transaction_hash, log_index)` and `event_data` retains serialized ABI arguments.

Compatibility projections are limited to the canonical Supabase tables and
ownership contract. No local-only event tables are written. USDm `Transfer`
logs remain in the authoritative `blockchain_events` ledger with serialized
integer arguments.

`indexer_state` is the restart checkpoint used by the poller. `indexer_sync_state` mirrors canonical contract progress for shared database consumers. A checkpoint advances only after its complete block range and block anchor are persisted.

No CELO balance, native token, or fabricated zero value is indexed. Missing ABI fields remain in `event_data`; projections must not infer business facts that are absent from the chain.
