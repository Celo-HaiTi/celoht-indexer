# CONTRIBUTING.md

## Before opening a PR
```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

## Rules specific to this repository
- Never hardcode a contract address, event name, or ABI fragment in source
  — load addresses from `deployments/*.json` and ABIs from `abis/*.json`.
  The ESLint rule in `.eslintrc.json` flags obvious hex-address literals as
  a backstop, but reviewers should still check for hand-typed event names.
- Never write to a BACKEND OWNED table (see
  `celoht-supabase/docs/OWNERSHIP.md` and `docs/DATABASE.md`).
- Any new derived-table write must go through an upsert keyed on a natural
  blockchain identity to preserve idempotency.
- Do not add Mainnet support outside the reviewed process in
  `docs/NETWORKS.md`.
