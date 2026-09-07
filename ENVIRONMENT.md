# ENVIRONMENT.md

| Variable | Required | Default | Notes |
|---|---|---|---|
| `SUPABASE_URL` | yes | — | |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | — | Secret |
| `CELO_NETWORK` | yes | — | Must match a file in `deployments/` and `ALLOWED_NETWORKS` |
| `CELO_RPC_URL` | yes | — | |
| `CONFIRMATIONS` | no | 5 | Blocks held back from head before indexing |
| `BACKFILL_BATCH_SIZE` | no | 2000 | Max blocks per `getLogs` call |
| `POLL_INTERVAL_MS` | no | 15000 | Delay between sync passes |
| `RPC_MAX_RETRIES` | no | 5 | Retry attempts per RPC call |
| `RPC_TIMEOUT_MS` | no | 15000 | Per-request RPC timeout |
| `PORT` | no | 8080 | Health server port |
