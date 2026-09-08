# CeloHT Indexer Production-Readiness Audit

Date: 2026-09-08

## A. Repository Status

The indexer source, migrations, integration scripts, CI workflow, and documentation were inspected. Temporary canonical repository clones and test containers are not part of the repository.

## B. Architecture Inspected

Verified configuration, ABI loading, RPC verification/retry, event decoding, backfill/live polling, persistence, checkpoints, reorg handling, health endpoints, shutdown, migrations, CI, and security documentation.

## C. USDm ABI Source and Verification

The canonical `celoht-smart-contracts` repository was inspected at commit `bdfc9ecf879f09418fb609b0695986b5dbe6ee27`. It contains `MockUSDm` as a test-only token, but does not publish the deployed USDm artifact for `0xdE9e4C3ce781b4bA68120d6261cbad65ce0aB00b`.

The indexer now requires `abis/USDm.json`, validates that it is a real ABI, and requires the canonical `Transfer(address indexed,address indexed,uint256)` event. It has no mock or hand-authored fallback and fails closed when the file is missing.

## D. USDm Contract and Network

The deployment manifest matches the canonical manifest for Celo Sepolia, chain ID `11142220`, addresses, treasuries, deployment blocks, and deployment transaction hashes. The real RPC endpoint `https://forno.celo-sepolia.celo-testnet.org` reported chain ID `11142220`. Real RPC checks also verified deployed USDm bytecode and 15 USDm Transfer logs.

## E. PostgreSQL Integration Results

Passed against a real PostgreSQL 16 container: clean migration application, foreign keys, unique constraints, event upserts, duplicate idempotency, checkpoint persistence, transaction rollback, and checkpoint transaction behavior.

## F. Celo RPC Integration Results

Passed against real Celo Sepolia: chain ID, latest block, block retrieval, deployment transaction retrieval, governance bytecode, USDm bytecode, bounded governance log queries, and USDm Transfer log retrieval. The test respects Forno's 100,000-block `eth_getLogs` range limit.

## G. Failure-Test Results

Passed: database rollback, duplicate block processing, invalid checkpoint rejection, unavailable RPC rejection, and missing ABI rejection. The runtime also fails closed for wrong chain IDs, absent contract bytecode, malformed events, database errors, RPC errors, and checkpoint persistence errors.

## H. Migration Results

The local migration chain `001_indexer_schema.sql` plus `002_atomic_checkpoint.sql` applied successfully to a clean PostgreSQL 16 database. The checkpoint function commits the indexed block and both checkpoint ledgers atomically.

## I. Idempotency and Checkpoints

Event identity is `(chain_id, transaction_hash, log_index)`. Block and event upserts were exercised against PostgreSQL. Checkpoints advance only after the event range succeeds and the atomic checkpoint function commits.

## J. Reorg and Recovery

Confirmation depth, stored block hashes, rollback, orphan status, and replay paths were inspected. Reorg observations are marked orphaned rather than deleted from canonical history. A live process-kill/restart rehearsal and a real chain-reorg rehearsal still require an isolated target environment.

## K. Security Findings

No secrets are committed or logged. Startup validates configuration, chain ID, contract bytecode, and ABI presence. Service-role writes are limited by the documented ownership contract. The integration scripts require explicit URLs and never silently skip missing infrastructure.

## L. CI/CD Status

CI includes lint, typecheck, unit tests, build, audit, CodeQL, a real PostgreSQL service, and real Celo Sepolia integration commands. The integration job fails if PostgreSQL or RPC access is unavailable.

## M. Documentation Status

README, configuration, operations, database, architecture, ABI, and this audit document describe the canonical USDm requirement, migrations, integration commands, health checks, checkpoint behavior, reorg handling, and recovery.

## N. Remaining Blockers

1. The deployed canonical USDm ABI artifact is not published in the accessible canonical repository. It must be supplied as `abis/USDm.json` and verified against the deployed address and required event signature.
2. The atomic migration/function and restart/reorg rehearsal still need execution against the target Supabase project, not only the isolated local PostgreSQL container.

## O. Exact Verification Commands

```text
npm test -- --run tests
npm run typecheck
npm run lint
npm run build
POSTGRES_TEST_URL=postgresql://... npm run test:integration:postgres
CELO_RPC_URL=https://forno.celo-sepolia.celo-testnet.org npm run test:integration:rpc
POSTGRES_TEST_URL=postgresql://... npm run test:integration:failure
```

## P. Final Verdict

**NOT PRODUCTION READY**

The verdict remains blocked because the canonical deployed USDm ABI is not available and target Supabase/restart/reorg validation has not been executed.
