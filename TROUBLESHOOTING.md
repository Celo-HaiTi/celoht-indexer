# TROUBLESHOOTING.md

**"Missing ABI file for X"** — populate `abis/<ContractName>.json` from the
official `celoht-smart-contracts` build artifacts (see `abis/README.md`).
That contract is skipped, not fabricated, until fixed.

**"RPC endpoint reports chainId ... but deployment metadata declares ..."**
— `CELO_RPC_URL` points at the wrong network for the configured
`CELO_NETWORK`. Fix one or the other; the indexer refuses to start rather
than index against a mismatched chain.

**"Could not find a canonical block within N blocks"** — an unusually deep
reorg. Investigate manually; do not raise `maxLookback` casually without
verifying the chain's actual reorg depth.

**Derived table (agent_transactions/governance_activity/etc.) rows are
missing even though blockchain_transactions has rows** — likely an event
or argument name mismatch in `src/indexing/persist.ts` against the real
ABI (see the warning comment at the top of that file). Check the warn-level
logs (`*_missing_fields`, `vote_cast_unknown_proposal`,
`agent_registry_event_no_matching_agent`) for specifics.

**Health endpoint returns 503** — check the JSON body's `reason` field:
`chain_id_mismatch` or `database_unreachable` point directly at the failing
dependency.
