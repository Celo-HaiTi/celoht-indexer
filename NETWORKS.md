# NETWORKS.md

| Network | Chain ID | Status |
|---|---|---|
| Celo Sepolia | 11142220 | Active — `deployments/celoSepolia.json` present |
| Celo Mainnet | 42220 | **Disabled.** No deployment file exists, and `ALLOWED_NETWORKS` in `src/config/network.ts` deliberately excludes it |

## Enabling Mainnet (future)
1. Obtain official Mainnet deployment metadata from
   `Celo-HaiTi/celoht-smart-contracts`.
2. Add `deployments/celoMainnet.json` in the same shape as
   `deployments/celoSepolia.json`.
3. Add `"celoMainnet"` to `ALLOWED_NETWORKS` in `src/config/network.ts` in a
   reviewed pull request — never as a hotfix.
4. Re-run the full test suite and a fresh backfill against a staging
   Supabase project before pointing at production.

Until all four steps are done, any attempt to start this indexer against
Mainnet throws `NetworkConfigError` (see `tests/network.test.ts`).
