# DEPLOYMENT.md

Runs as a long-lived Node.js process (not serverless — it holds an open
poll loop and an HTTP health server).

Apply `migrations/001_indexer_schema.sql`, `002_atomic_checkpoint.sql`, and
`003_checkpoint_recovery.sql` (or equivalent reviewed `celoht-supabase`
migrations) before starting. Migration 003 enables RLS on indexer-owned tables,
keeps writes service-role-only, and adds guarded checkpoint recovery. Configure
only the Celo Sepolia manifest in this release; Mainnet intentionally fails
closed. The database role should be limited to the indexer-owned tables in
`DATA_MODEL.md`.

```bash
npm ci
npm run build
npm start
```

The build emits native Node.js ESM. `tsc-alias` rewrites the source `@/*`
aliases to relative imports and appends `.js` extensions, so `npm start` can
execute `dist/index.js` directly without a runtime alias loader.

The configured Celo Sepolia RPC must support historical reads from the
official contract deployment blocks. Public RPC endpoints with a recent-block
retention limit are insufficient for the initial backfill; use an archive or
historical-capable Celo Sepolia provider without changing the chain or the
verified deployment metadata.

For Render, keep `healthCheckPath` set to `/health`. It checks RPC and database
availability without failing solely because the initial historical backfill is
still catching up. `/readyz` is stricter and returns 503 until every checkpoint
reaches the confirmed head; use it for readiness monitoring, not Render's
deployment health check. Set the three unsynced Render variables
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `CELO_RPC_URL` to real values
in the Render dashboard. Configure automatic restart on crash — `main()` exits with code 1 on any
unrecoverable startup error (missing env, invalid network config, RPC/chain
mismatch), which should be treated as "needs operator attention," not
silently retried forever without alerting.
