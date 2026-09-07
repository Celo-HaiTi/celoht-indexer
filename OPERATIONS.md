# OPERATIONS.md

## Starting the indexer
```bash
npm ci
cp .env.example .env   # fill in
npm run build
npm start
```

## Health endpoint
`GET http://localhost:8080/health` or `/readyz` (port from `$PORT`, default 8080)
returns 200 with RPC/database status, chain head, per-contract indexed lag, and
last successful sync data. It returns 503 for an RPC or database failure, chain
mismatch, or checkpoint error.

## Backfill and recovery

The normal process continuously backfills from each durable checkpoint to the
latest confirmed block. To test a range without changing Supabase, set
`DRY_RUN=true` and `START_BLOCK` to the desired lower bound. A restart is safe:
the last completed batch is the resume cursor and event upserts are idempotent.
If the database is unavailable, the process records no successful checkpoint;
the next poll retries the failed pass, and restart resumes from the last durable
checkpoint. A detected reorg rolls back invalidated events, token transfers,
domain rows, and block anchors before replaying them after the next confirmation
pass.

## Common operational tasks
- **Re-run a range**: since persistence is idempotent, you can safely
  re-invoke backfill over an already-processed range (e.g. after fixing an
  ABI) — duplicates are impossible by the unique constraint.
- **Force a reorg re-check**: `detectAndHandleReorg` runs automatically at
  the start of every sync pass; no manual trigger is needed in normal
  operation.
- **Add a network**: see `NETWORKS.md`.
