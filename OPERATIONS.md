# OPERATIONS.md

## Starting the indexer
```bash
npm ci
cp .env.example .env   # fill in
# populate abis/ per abis/README.md
npm run build
npm start
```

## Health endpoint
`GET http://localhost:8080/health` (port from `$PORT`, default 8080)
returns 200 with per-contract sync lag when healthy, 503 when the RPC/chain
ID mismatches or the database is unreachable, and reflects `degraded` if
any contract's `indexer_state.sync_status = 'error'`.

## Common operational tasks
- **Re-run a range**: since persistence is idempotent, you can safely
  re-invoke backfill over an already-processed range (e.g. after fixing an
  ABI) — duplicates are impossible by the unique constraint.
- **Force a reorg re-check**: `detectAndHandleReorg` runs automatically at
  the start of every sync pass; no manual trigger is needed in normal
  operation.
- **Add a network**: see `docs/NETWORKS.md`.
