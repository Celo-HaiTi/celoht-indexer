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
`docs/ARCHITECTURE.md`, `docs/INDEXING.md`, `docs/CONTRACTS.md`,
`docs/NETWORKS.md`, `docs/DATABASE.md`, `docs/SECURITY.md`,
`docs/OPERATIONS.md`, `docs/DEPLOYMENT.md`, `docs/ENVIRONMENT.md`,
`docs/TROUBLESHOOTING.md`, `docs/CONTRIBUTING.md`.

## Known blocker before production use
**ABI files are not included** (no network access to fetch them from
`Celo-HaiTi/celoht-smart-contracts` in the environment this was built in).
Without them, `main()` skips every contract and refuses to start
(`No contracts are indexable`). Populate `abis/` first. Additionally, the
specific event/argument names assumed in `src/indexing/persist.ts` are
placeholders — see the warning comment at the top of that file — and must
be reconciled against the real ABI before the derived tables
(`agent_transactions`, `reforestation_contributions`, `governance_*`,
`agents.on_chain_registry_status`) can be trusted.

## Verification status (Phase 3)
- [x] Builds, typechecks, lints under strict TypeScript.
- [x] Tests cover: fail-closed network/env config, Mainnet exclusion,
      malformed-log rejection, ABI-missing fail-closed behavior, retry
      backoff behavior.
- [x] Idempotent persistence via DB-level unique constraints, not
      application-level guessing.
- [x] Reorg detection walks back to a verified canonical block before
      resuming, and deletes invalidated rows rather than trusting them.
- [ ] Full backfill + live sync against real Celo Sepolia data (requires
      the real ABIs — see blocker above).
- [ ] Cross-repository verification against `celoht-backend` and
      `celoht-supabase` in a shared staging environment.
