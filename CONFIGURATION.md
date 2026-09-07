# Configuration

Copy `.env.example` to `.env` for local development. Production values must come from a secret manager; `.env` is ignored and must never be committed.

| Variable | Required | Meaning |
|---|---:|---|
| `SUPABASE_URL` | yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Server-only writer credential; never log it |
| `CELO_NETWORK` | yes | Must be `celoSepolia` in this release |
| `CELO_RPC_URL` | yes | RPC endpoint verified against chain ID `11142220` |
| `CONFIRMATIONS` | no | Confirmation depth, default `5` |
| `BACKFILL_BATCH_SIZE` | no | `getLogs` range size, default `2000` |
| `POLL_INTERVAL_MS` | no | Reconciliation interval, default `15000` |
| `RPC_MAX_RETRIES` | no | Exponential-backoff retry count, default `5` |
| `RPC_TIMEOUT_MS` | no | Per-request timeout, default `15000` |
| `START_BLOCK` | no | Initial cursor; deployment metadata remains the lower bound |
| `DRY_RUN` | no | `true` decodes and logs without Supabase writes |
| `PORT` | no | Health server port, default `8080` |

Mainnet is not an accepted network value. Adding it requires an authoritative smart-contract deployment manifest, matching ABIs, chain/RPC verification, and a reviewed code/configuration change.
