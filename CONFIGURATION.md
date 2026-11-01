# Configuration

Copy `.env.example` to `.env` for local development. Production values must come from a secret manager; `.env` is ignored and must never be committed.

| Variable | Required | Meaning |
|---|---:|---|
| `SUPABASE_URL` | yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Server-only writer credential; never log it |
| `CELO_NETWORK` | yes | Must be `celoSepolia` in this release |
| `CELO_RPC_URL` | yes | Normal/live RPC; verified against chain ID `11142220`; used for head/confirmation polling and contract checks |
| `CELO_SEPOLIA_ARCHIVE_RPC_URL` | no | Historical RPC for logs, block verification, reorg checks, and backfill; defaults to `CELO_RPC_URL` for compatibility, but startup requires it to serve block `35343240` on chain `11142220` |
| `abis/USDm.json` | yes | Canonical deployed USDm ABI artifact; startup fails if missing or invalid |

USDm is indexed only when `abis/USDm.json` is present and contains the verified
ERC-20 `Transfer` event. The repository does not provide a mock or hand-authored
fallback. The artifact must be supplied from the canonical deployment source
and independently checked against the manifest address `0xdE9e4C3ce781b4bA68120d6261cbad65ce0aB00b`.
| `CONFIRMATIONS` | no | Confirmation depth, default `5` |
| `BACKFILL_BATCH_SIZE` | no | Maximum adaptive `getLogs` range size, default `2000` |
| `BACKFILL_MIN_BATCH_SIZE` | no | Smallest range used while adapting to provider limits, default `100`; if that range still fails, backfill stops with an explicit error |
| `BACKFILL_RPC_CONCURRENCY` | no | Maximum concurrent archive `getLogs` requests during split-range recovery, default `2` |
| `BACKFILL_CHUNKS_PER_PASS` | no | Verified chunks each contract processes before polling the live head again, default `1` |
| `POLL_INTERVAL_MS` | no | Reconciliation interval, default `15000` |
| `RPC_MAX_RETRIES` | no | Exponential-backoff retry count, default `5` |
| `RPC_TIMEOUT_MS` | no | Per-request timeout, default `15000` |
| `START_BLOCK` | no | Initial cursor; deployment metadata remains the lower bound |
| `DRY_RUN` | no | `true` decodes and logs without Supabase writes |
| `PORT` | no | Health server port, default `8080` |

Mainnet is not an accepted network value. Adding it requires an authoritative smart-contract deployment manifest, matching ABIs, chain/RPC verification, and a reviewed code/configuration change.

Backfill begins at `BACKFILL_BATCH_SIZE`, splits only provider errors classified
as maximum block range, response-size, or too-many-logs limits, then gradually
increases after successful smaller ranges. HTTP 429 responses honor
`Retry-After` when provided; timeouts and provider-internal errors back off but
never trigger range splitting. Historical retention errors are permanent and
are not retried. Each completed chunk commits only after its logs and canonical
boundary header have been verified; after `BACKFILL_CHUNKS_PER_PASS` chunks, the
loop polls the live head again before continuing historical work.
