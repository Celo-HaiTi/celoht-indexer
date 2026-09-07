# Data Model

The migration in `migrations/001_indexer_schema.sql` is the indexer-owned Postgres contract.

`indexed_blocks` stores canonical block number, hash, parent hash, timestamp, and confirmation time. `indexed_transactions` stores transaction hash, block provenance, transaction index, and confirmation state. `blockchain_events` is the lossless decoded ledger; its unique key is `(chain_id, transaction_hash, log_index)` and `event_data` retains serialized ABI arguments.

`agent_events`, `service_payment_events`, `education_events`, `reforestation_events`, and `governance_events` are domain-specific copies of the canonical event row for efficient consumers. `token_transfers` stores only verified USDm `Transfer` logs and preserves raw integer amounts as text.

`indexer_state` is the restart checkpoint used by the poller. `indexer_sync_state` mirrors canonical contract progress for shared database consumers. A checkpoint advances only after its complete block range and block anchor are persisted.

No CELO balance, native token, or fabricated zero value is indexed. Missing ABI fields remain in `event_data`; projections must not infer business facts that are absent from the chain.
