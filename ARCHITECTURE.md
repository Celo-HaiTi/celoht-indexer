# ARCHITECTURE.md

```
deployments/celoSepolia.json  (official addresses/blocks)
abis/*.json                   (official compiled ABIs — must be supplied)
        |
        v
   src/config     ->  validated network + ABI + env config, fail-closed
        |
        v
   src/chain      ->  RPC client, verified against declared chainId, retry/backoff
        |
        v
   src/indexing   ->  decode -> validate -> persist, backfill + live poll loop, reorg handling
        |
        v
   src/db         ->  Supabase service-role client, checkpoints, idempotent upserts
        |
        v
   Supabase Postgres (celoht-supabase schema)
        |
        v
   celoht-backend reads indexer-owned tables (never writes them)
```

This process is the **only** writer of `blockchain_transactions`,
`agent_transactions`, `reforestation_contributions`, `governance_proposals`,
`governance_activity`, `indexer_state`, and `agents.on_chain_registry_status`
(update-only). It never becomes an application backend — no user-facing
authentication, no admin workflows, no content publishing.
