# ARCHITECTURE.md

```
deployments/celoSepolia.json  (official addresses/blocks)
abis/*.json                   (compiled artifacts from the official source)
        |
        v
   src/config     ->  validated network + ABI + env config, fail-closed
        |
        v
   src/chain      ->  RPC client, verified against declared chainId, retry/backoff
        |
        v
     src/indexing   ->  decode -> validate -> persist, USDm transfers, backfill + live poll loop, reorg handling
        |
        v
     src/db         ->  canonical Supabase ledger, compatibility rows, checkpoints
        |
        v
   Supabase Postgres (celoht-supabase schema)
        |
        v
   celoht-backend reads indexer-owned tables (never writes them)
```

The canonical persistence path writes `blockchain_networks`, `contracts`,
`indexed_blocks`, `indexed_transactions`, `blockchain_events`, and
`indexer_sync_state`. Compatibility ledger rows are also written where the
Supabase schema supports them. Idempotency is keyed by
`(chain_id, transaction_hash, log_index)` and checkpoints advance only after a
whole log range succeeds. Reorg checks compare stored block hashes and roll
back invalidated events before replay.

Compatibility projections are written only where the canonical Supabase
ownership contract defines them. All decoded events, including USDm transfers,
remain authoritative in `blockchain_events`; CELO is never treated as a
settlement asset.

This process never becomes an application backend: no user authentication, no
transaction signing, no admin workflows, and no backend-owned content writes.
