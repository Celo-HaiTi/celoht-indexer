# ENVIRONMENT.md

| Variable | Required | Default | Notes |
|---|---|---|---|
| `SUPABASE_URL` | yes | — | |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | — | Secret |
| `CELO_NETWORK` | yes | — | Must match a file in `deployments/` and `ALLOWED_NETWORKS` |
| `CELO_RPC_URL` | yes | — | Normal/live endpoint for chain head and contract checks |
| `CELO_SEPOLIA_ARCHIVE_RPC_URL` | no | `CELO_RPC_URL` | Archive endpoint; startup must retrieve Celo Sepolia block 35343240 |
| `CONFIRMATIONS` | no | 5 | Blocks held back from head before indexing |
| `BACKFILL_BATCH_SIZE` | no | 2000 | Adaptive maximum range size for `getLogs` |
| `BACKFILL_MIN_BATCH_SIZE` | no | 100 | Minimum range size before returning a provider error |
| `BACKFILL_RPC_CONCURRENCY` | no | 2 | Maximum concurrent archive log requests during range splitting |
| `BACKFILL_CHUNKS_PER_PASS` | no | 1 | Verified chunks per contract before refreshing the live head |
| `POLL_INTERVAL_MS` | no | 15000 | Delay between sync passes |
| `RPC_MAX_RETRIES` | no | 5 | Retry attempts per RPC call |
| `RPC_TIMEOUT_MS` | no | 15000 | Per-request RPC timeout |
| `PORT` | no | 8080 | Health server port |
