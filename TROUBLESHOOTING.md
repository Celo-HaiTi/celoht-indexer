# TROUBLESHOOTING.md

**Indexer exits after `indexer_starting`** — inspect `indexer_fatal_error.stage`
and the structured `error` object (`name`, `message`, `code`, `status`, response
details, and nested `cause`). The logger redacts configured secrets, authorization
data, and URL paths; still do not copy credentials into tickets or chat.

- `environment_validation` / `deployment_manifest_validation` — check the
	required variables and `CELO_NETWORK=celoSepolia`; the manifest must declare
	chain ID `11142220`.
- `rpc_verification` — check the `rpc_chain_id_check_failed` or
	`rpc_contract_code_check_failed` event. Verify the configured Celo Sepolia RPC
	responds with chain ID `11142220` and serves the official contract bytecode.
	Historical `getLogs` failures happen after startup and appear as
	`sync_pass_failed` / `rpc_retry`; use an RPC with historical block access.
- `contract_setup:<name>` / `usdm_abi_and_checkpoint_setup` — check the named
	ABI and, when not in dry-run mode, Supabase access to the indexer schema and
	checkpoint tables.
- `supabase_health_write` — verify the service-role credential and the reviewed
	migrations, including `system_health` and checkpoint RPC permissions.

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
