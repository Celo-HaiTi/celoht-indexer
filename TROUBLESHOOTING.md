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

**A domain event or transfer row is missing** — inspect `blockchain_events`
first. The raw ABI arguments there are authoritative; malformed logs are
rejected and a missing optional projection field is never replaced with a
fabricated value. Check warn-level logs for the affected transaction and log.

**Health endpoint returns 503** — check the JSON body's `reason` field:
`chain_id_mismatch` or `database_unreachable` point directly at the failing
dependency.
