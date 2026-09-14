# CeloHT Production Readiness

## Repository

Name: `celoht-indexer`

Purpose: CeloHT indexer for Celo Sepolia. This repository synchronizes verified smart-contract events into Supabase-owned data structures, maintains durable checkpoints, handles reorg recovery, and exposes health/readiness signals for operators.

## Repository Type

Indexer

## Status

NOT READY

Internal implementation is complete for the code and local verification
available in this workspace. Live Supabase/PostgreSQL and Celo Sepolia
integration verification remains unexecuted because no target credentials were
provided.

## Operational Readiness Matrix

| Component | Current State | Required Work | Can Implement Internally? | External Audit Required? | Final Status |
| --- | --- | --- | --- | --- | --- |
| Runtime configuration | Fail-closed Zod validation | None locally | Yes | No | COMPLETE |
| RPC and deployment metadata | Celo Sepolia chain and bytecode checks enabled | Run against target RPC | Yes | No | NEEDS DEPLOYMENT |
| ABI loading and decoding | Official artifacts validated and malformed logs rejected | None locally | Yes | No | COMPLETE |
| Backfill and live polling | Confirmed-range polling with bounded retries | Exercise restart behavior on target infrastructure | Yes | No | NEEDS TESTING |
| Persistence and checkpoints | Canonical and compatibility ledgers with atomic progress | Apply and run against target Supabase schema | Yes | No | NEEDS INTEGRATION |
| Reorg handling | Hash verification and rollback path implemented | Exercise against a fork or controlled reorg | Yes | No | NEEDS TESTING |
| Health and readiness | `/health` dependency status and `/readyz` catch-up gate | Verify through deployed process | Yes | No | NEEDS DEPLOYMENT |
| Security controls | Secret-free repository, fail-closed network, zero high audit vulnerabilities | Independent review after deployment | Yes | Yes | PENDING EXTERNAL AUDIT |

## What Works

- Verified environment validation and fail-closed config loading.
- Verified network metadata loading and chain allowlist enforcement.
- RPC client verification against the declared chain ID and deployed bytecode.
- ABI artifact loading with SHA-256 verification for `USDm`.
- Event decoding with malformed log rejection.
- Chunked backfill and checkpoint advancement.
- Reorg detection and rollback logic.
- Canonical and compatibility persistence paths.
- Health and readiness HTTP endpoint.
- Parent-block and transaction-index provenance in both event ledgers.
- Concurrent-safe initialization for canonical and compatibility checkpoints.
- Readiness that remains false until every configured target reaches the confirmed chain.
- Unit tests and TypeScript build/lint coverage.

## Tests

Executed successfully:

- `npm test` — 5 test files passed, 21 tests passed.
- `npm run typecheck` — succeeded.
- `npm run build` — succeeded.
- `npm run lint` — succeeded (with a non-blocking TypeScript compatibility warning from `@typescript-eslint`).
- `npm audit --audit-level=high` — reported 0 vulnerabilities.
- `npm run test:integration:rpc` — passed against Celo Sepolia, chain `11142220`.

Not executed in this workspace because required environment variables were unavailable:

- `npm run test:integration:postgres`
- `npm run test:integration:failure`

## Security

Completed checks:

- Verified no secrets are committed in the repository.
- Verified environment configuration is fail-closed and does not fall back to mocked credentials.
- Verified chain ID and bytecode checks at startup.
- Verified malformed event rejection and no production writes in `DRY_RUN=true` mode.
- Verified health endpoints do not report healthy when critical dependencies are unavailable.

Remaining security review needed:

- Live target Supabase and RPC verification using the real deployment environment.

## Deployment

Observed deployment characteristics:

- Long-lived Node.js process.
- Requires the Celo Sepolia manifest and ABIs from the official smart-contract source.
- Requires a Supabase project with the indexer schema.
- Mainnet is intentionally disabled and fails closed.
- Health endpoints available at `/health` and `/readyz`.

## External Dependencies

- `Celo-HaiTi/celoht-smart-contracts` — source of deployment metadata and ABI artifacts.
- `Celo-HaiTi/celoht-supabase` — database schema and ownership rules for indexer-writable tables.
- Celo Sepolia RPC endpoint.
- Supabase project with the required schema and service-role credentials.

## P0

- Live target Supabase and Celo Sepolia verification is not complete in this workspace because required environment variables are missing.

## P1

- No unresolved internal P1 engineering issue was identified after the fixes in this session.

## P2

- `@typescript-eslint` emits a TypeScript compatibility warning; toolchain alignment is a maintenance improvement.
- A deployment runbook for the concrete hosting environment is not present in-repository.

## Remaining Internal Work

- Execute the real PostgreSQL, RPC, failure, restart, and reorg integration checks against a disposable or target environment.
- Verify the deployed health/readiness behavior and checkpoint recovery.

## External Audit Required

### PENDING EXTERNAL AUDIT

- Independent smart-contract security audit of the upstream contracts.
- Independent penetration/security assessment of the deployed operational surface.

These reviews do not replace the live integration and deployment checks above.

## Blockers

### What is missing

- Real `POSTGRES_TEST_URL` / `DATABASE_URL` and `CELO_RPC_URL` for the target environment.

### Why it matters

- Without the real target environment, the repository cannot be fully verified for production deployment.

### What is required

- Real `POSTGRES_TEST_URL` / `DATABASE_URL` access is required to execute the remaining database integration checks; the public Celo Sepolia RPC check passed.

## Final Status

NOT READY

## Next Action

Run `npm run test:integration:postgres` and
`npm run test:integration:failure` with a disposable PostgreSQL database, then
perform a restart/recovery rehearsal against the same environment.

## Evidence

- `package.json` defines the indexer’s scripts and runtime dependencies.
- `src/config/env.ts` implements fail-closed environment validation.
- `src/chain/provider.ts` verifies chain ID and contract bytecode.
- `src/indexing/eventDecoder.ts` rejects malformed logs.
- `src/indexing/backfill.ts` implements chunked backfill.
- `src/indexing/reorg.ts` implements rollback and reorg handling.
- `src/db/checkpoints.ts` manages durable checkpoints.
- `src/health/server.ts` exposes health and readiness.
- `migrations/001_indexer_schema.sql` and `migrations/002_atomic_checkpoint.sql` define the schema and atomic checkpoint function.
- `.github/workflows/ci.yml` validates lint, typecheck, tests, build, and audit.
- Local verification results from this session: `npm test`, `npm run typecheck`, `npm run build`, `npm run lint`, and `npm audit --audit-level=high` all succeeded.
