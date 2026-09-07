# DEPLOYMENT.md

Runs as a long-lived Node.js process (not serverless — it holds an open
poll loop and an HTTP health server).

Apply `migrations/001_indexer_schema.sql` (or the equivalent reviewed
`celoht-supabase` migration) before starting. Configure only the Celo Sepolia
manifest in this release; Mainnet intentionally fails closed. The database
role should be limited to the indexer-owned tables in `DATA_MODEL.md`.

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

Point your platform's liveness/readiness probe at `GET /health` or `GET /readyz`. Configure
automatic restart on crash — `main()` exits with code 1 on any
unrecoverable startup error (missing env, invalid network config, RPC/chain
mismatch), which should be treated as "needs operator attention," not
silently retried forever without alerting.
