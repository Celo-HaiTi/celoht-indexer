# INDEXING.md

## Data flow (per contract, per sync pass)
```
checkpoint (indexer_state.last_processed_block)
  -> reorg check (src/indexing/reorg.ts)
  -> confirmed head = chain head - CONFIRMATIONS (src/chain/provider.ts)
  -> chunked getLogs() over [checkpoint+1, confirmedHead] (src/indexing/backfill.ts)
  -> decode + validate each log (src/indexing/eventDecoder.ts)
  -> persist (idempotent upsert) (src/indexing/persist.ts)
  -> advance checkpoint
  -> repeat every POLL_INTERVAL_MS (src/indexing/liveSync.ts)
```

## Backfill
`runBackfill` processes `[fromBlock, toBlock]` in chunks of
`BACKFILL_BATCH_SIZE` blocks. The checkpoint advances only after a full
chunk's logs are persisted, so a crash mid-chunk simply re-fetches that
chunk on restart (safe due to upsert idempotency) rather than losing or
duplicating data.

## Live synchronization
`startLiveSyncLoop` repeatedly calls the same reconcile pass used for
backfill — there is no separate "live" code path with different semantics,
and it does not depend on WebSocket subscriptions (poll/reconcile model),
matching the project's reliability requirement.

## Idempotency
Every row in `blockchain_transactions` is upserted on
`(chain_id, transaction_hash, log_index)`, which is a `unique` constraint in
the schema. Re-running the same block range (crash recovery, manual
re-backfill) can never create a duplicate.

## Confirmations
`CONFIRMATIONS` (default 5) blocks are held back from the chain head before
any block is treated as "confirmed" and eligible for indexing. Observed but
unconfirmed blocks are never persisted. Every persisted event records its
contract, block, parent block, transaction, log position, timestamp, and
confirmation state.

## Reorg handling
See `src/indexing/reorg.ts`. Before extending a checkpoint forward, the
indexer verifies durable `indexed_blocks` anchors, including ranges with no
contract events. On mismatch, it walks backward through anchors (up to 50
anchors by default), deletes invalidated rows, and resumes from the canonical
anchor. An unusually deep reorg throws rather than guessing.
An unusually deep reorg (beyond the lookback window) throws rather than
guessing a rollback point.

## Graceful shutdown
`SIGINT`/`SIGTERM` stop the poll loop after the in-flight pass completes,
then close the health server, before exiting — no persistence call is
interrupted mid-write by a forced kill.
