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

Point your platform's liveness/readiness probe at `GET /health` or `GET /readyz`. Configure
automatic restart on crash — `main()` exits with code 1 on any
unrecoverable startup error (missing env, invalid network config, RPC/chain
mismatch), which should be treated as "needs operator attention," not
silently retried forever without alerting.
