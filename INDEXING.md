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
`runBackfill` fetches logs and historical headers from the archive RPC, in
bounded chunks up to `BACKFILL_BATCH_SIZE`. It splits only provider errors
classified as block-range, response-size, or too-many-logs limits, preserving
adjacent inclusive ranges exactly. After a successful smaller range, its
adaptive size grows gradually up to the configured ceiling. HTTP 429 honors
`Retry-After`; timeouts and provider-internal errors back off without splitting.
Splits stop at `BACKFILL_MIN_BATCH_SIZE` and fail explicitly if the provider
still rejects the range.

Each event-bearing block header is fetched once per chunk and verified against
the log's block hash. A verified boundary header is fetched even for an empty
log range. The checkpoint advances only after every log in the chunk is
persisted and that canonical boundary header is verified. A crash mid-chunk
re-fetches that chunk safely through idempotent upserts. The bounded
`BACKFILL_RPC_CONCURRENCY` applies to split log-range requests, and
`BACKFILL_CHUNKS_PER_PASS` yields back to live-head polling between chunks.

## Live synchronization
`startLiveSyncLoop` polls head/confirmations through `CELO_RPC_URL` and routes
backfill, checkpoint verification, and reorg checks through
`CELO_SEPOLIA_ARCHIVE_RPC_URL`. It repeatedly calls the same reconcile pass;
there is no separate "live" indexing path and no WebSocket dependency.

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
guessing a rollback point.
eligible canonical or confirmed anchors by default), marks invalidated block,
event, and transaction observations orphaned, and resumes from the nearest
RPC-verified canonical anchor. Orphaned block rows remain available for
reconciliation. Missing or inconsistent anchor history and RPC responses fail
closed with diagnostics; a full lookback of mismatching anchors is reported as
an unresolved deep reorganization.

## Graceful shutdown
`SIGINT`/`SIGTERM` stop the poll loop after the in-flight pass completes,
then close the health server, before exiting — no persistence call is
interrupted mid-write by a forced kill.
