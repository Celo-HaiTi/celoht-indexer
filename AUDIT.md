# Repository Audit

## Repository Role

This repository is the CeloHT Indexer. Its responsibility is to synchronize verified Celo Sepolia blockchain events from the official CeloHT smart contracts into Supabase-owned indexer tables, maintain durable checkpoints, detect reorgs, and expose health/readiness signals for operators.

It is not the CeloHT DApp, wallet, backend, or website. It does not authenticate users, submit transactions, create application records, or maintain backend-owned business data.

## Architecture

The current architecture is:

- `deployments/celoSepolia.json` provides the verified Celo Sepolia deployment metadata and contract addresses.
- `abis/` contains ABI artifacts that are validated at startup; missing or malformed ABIs fail closed.
- `src/config/` validates environment, network metadata, and ABI artifacts.
- `src/chain/` creates a verified RPC client, checks chain ID and deployed bytecode, and provides reusable retry helpers.
- `src/indexing/` decodes logs, backfills confirmed ranges, performs reorg checks, and runs the poll loop.
- `src/db/` manages Supabase service-role access, canonical event persistence, checkpoint rows, and compatible ledger state.
- `src/health/` exposes `/health` and `/readyz` for operator monitoring.
- `migrations/` contains the SQL schema and the atomic checkpoint function used by the indexer.
- `scripts/integration/` contains integration checks that require real infrastructure credentials.

## Existing Functionality

Verified working functionality in this repository includes:

- Fail-closed environment configuration via `src/config/env.ts`.
- Network allowlist guarding, with mainnet intentionally disabled until explicit deployment metadata is added.
- RPC client verification against the declared chain ID and deployed contract bytecode in `src/chain/provider.ts`.
- Canonical ABI and deployment artifact validation in `src/config/network.ts`, `src/config/abiLoader.ts`, and `src/config/token.ts`.
- Event decoding and malformed log rejection in `src/indexing/eventDecoder.ts`.
- Chunked backfill processing and checkpoint advancement in `src/indexing/backfill.ts` and `src/db/checkpoints.ts`.
- Reorg detection and rollback logic in `src/indexing/reorg.ts`.
- Durable Supabase persistence of canonical events and indexed blocks in `src/db/canonical.ts`.
- Health/readiness server in `src/health/server.ts`.
- Unit test coverage for environment, ABI loading, network metadata, retry behavior, and event decoding.
- CI workflow in `.github/workflows/ci.yml` covering install, typecheck, lint, test, build, and audit.

## Incomplete Functionality

Functionality that is present but not fully verified in this environment includes:

- Live Supabase integration against the real target project.
- Restart and recovery rehearsal against a live or staging environment.
- Real reorg rehearsal on the target chain or a controlled forked environment.
- End-to-end production deployment verification for a hosted runtime.

## Mock/Simulated Functionality

There is no mock blockchain or fake token implementation in this repository.

The integration scripts are real infrastructure checks, but they are intentionally gated on environment variables and therefore do not run automatically in this workspace. The scripts are not fake; they are simply not executable here without real `POSTGRES_TEST_URL` and `CELO_RPC_URL` values.

## Dependencies

External dependencies and required services include:

- Celo Sepolia RPC endpoint for chain verification and historical reads.
- Supabase project using the CeloHT indexer schema and migrations from `celoht-supabase`.
- Official CeloHT smart-contract deployment metadata in `deployments/celoSepolia.json`.
- Matching ABI artifacts in `abis/` corresponding to the official smart-contract source repository.
- `USDm` artifact verification via `abis/USDm.json` and the pinned SHA-256 hash in `src/config/token.ts`.

## Security

Security posture observed in the repository:

- No private keys, API secrets, or service-role credentials are committed.
- The indexer only reads chain state and writes indexer-owned ledger data.
- Environment validation prevents missing or malformed configuration.
- RPC chain ID, bytecode presence, and ABI structure are checked before indexing.
- Malformed logs are rejected rather than persisted.
- `DRY_RUN=true` prevents writes to events, checkpoints, and canonical ledger tables.
- Health checks surface dependency failures and do not report a healthy state if critical dependencies are unavailable.

Security considerations and risks:

- The indexer uses a Supabase service-role key, which is necessary for the described write path, but it should be scoped using least privilege in the target Supabase project.
- `npm run lint` emits a TypeScript-version compatibility warning from `@typescript-eslint`, which is not a blocker but is a maintenance issue.
- CI runs `npm audit --audit-level=high` with `continue-on-error: true`; this does not block the workflow on newly introduced vulnerabilities.

## Deployment

Current deployment status observed from the repository:

- The application is a long-lived Node.js process, not a serverless function.
- It expects a configured Celo Sepolia environment, applied migrations, and a Supabase project that matches the indexer-owned schema.
- Mainnet is explicitly disabled until official deployment metadata is added intentionally.
- Health and readiness endpoints are available on `PORT` or `8080`.

## Documentation

Documentation present and useful includes:

- `README.md`
- `ARCHITECTURE.md`
- `CONFIGURATION.md`
- `DATA_MODEL.md`
- `DATABASE.md`
- `DEPLOYMENT.md`
- `INDEXING.md`
- `OPERATIONS.md`
- `SECURITY.md`
- `TROUBLESHOOTING.md`

Documentation gaps remaining:

- No repository-local instructions for the required live target environment variables beyond `.env.example`.
- No repository-local production deployment runbook for the actual operator-managed hosting environment.
- No explicit production verification checklist for restart/reorg validation against the target Supabase and RPC.

## Production Blockers

### P0 — Critical production blocker

1. Live target Supabase and Celo Sepolia verification remain unexecuted in this workspace because `POSTGRES_TEST_URL` / `DATABASE_URL` and `CELO_RPC_URL` are not configured.
   - Why it matters: the repository can build and pass unit tests, but the real end-to-end path has not been verified against the target environment.
   - Required action: provide real target environment credentials and run the integration checks against the actual Supabase project and RPC.

### P1 — Important production issue

1. The `npm audit` step in CI does not stop the workflow on newly introduced vulnerabilities because `continue-on-error: true` is set.
   - Why it matters: audit findings could be silently ignored in CI.
   - Required action: review whether the audit step should be blocking for the target governance process.

### P2 — Improvement

1. `npm run lint` shows a TypeScript-version compatibility warning from `@typescript-eslint`.
   - Why it matters: it is not currently a failure, but it indicates the toolchain is not perfectly aligned.
   - Required action: align the lint toolchain with the installed TypeScript version or document the current compatibility baseline.

2. The repository would benefit from an explicit operator deployment runbook for the real target environment.
   - Why it matters: production deployment is currently documented at a high level, but not fully tied to the actual hosting process.
   - Required action: add a deployment and verification checklist for the concrete runtime environment.

## Current Status

READY FOR TESTING

This repository is ready for local testing and integration setup against real infrastructure, but it is not yet verified for production deployment because the target environment has not been exercised in this session.
