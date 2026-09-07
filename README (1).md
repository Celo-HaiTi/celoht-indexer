# celoht-indexer

Phase 3 of the CeloHT production infrastructure: synchronizes the official
CeloHT smart contracts (Celo Sepolia) into the `celoht-supabase` database
that `celoht-backend` reads from.

This is **not** the application backend. It never serves the dApp directly,
never handles user auth, and never writes to backend-owned tables.

## Prerequisites
1. A `celoht-supabase` project with all migrations applied.
2. Real ABI files copied into `abis/` from
   `Celo-HaiTi/celoht-smart-contracts` — **not included in this repository**;
   see `abis/README.md` for why and how.
3. A Celo Sepolia RPC endpoint.

## Getting started
```bash
cp .env.example .env   # fill in
npm ci
npm run typecheck && npm run lint && npm test
npm run build
npm start
```

## What's included
- `deployments/celoSepolia.json` — the official deployment metadata as
  supplied for this network (addresses, deployment blocks, USDm, treasuries).
- `src/config` — fail-closed env/network/ABI loaders.
- `src/chain` — RPC client (chain-ID-verified at startup) + retry/backoff.
- `src/indexing` — event decoding/validation, idempotent persistence,
  chunked backfill, poll-based live sync, reorg detection/rollback.
- `src/db` — Supabase service-role client and checkpoint management.
- `src/health` — `/health` endpoint reflecting real dependency status.
- Full test suite (`tests/`) and CI (`.github/workflows/ci.yml`).

## Documentation
See the root documentation files, especially `DATA_MODEL.md`, `INDEXING.md`,
`OPERATIONS.md`, `SECURITY.md`, and `DEPLOYMENT.md`.

This repository includes the verified ABI set and fail-closed Celo Sepolia
deployment manifest. A live staging backfill still requires operator-provided
RPC and Supabase credentials and an applied database migration.
