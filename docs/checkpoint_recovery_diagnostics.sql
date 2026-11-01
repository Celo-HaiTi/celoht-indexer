-- Read-only production diagnostics for Celo Sepolia (chain ID 11142220).
-- Run in the Supabase SQL editor; do not edit checkpoint or observation rows
-- manually based on these results.

-- Compare both checkpoint ledgers for every configured contract and classify
-- indexed_blocks observations through the furthest recorded checkpoint.
select
  c.contract_name,
  c.contract_address,
  c.deployment_block,
  legacy.last_processed_block as indexer_state_block,
  legacy.latest_confirmed_block as indexer_state_confirmed,
  canonical.last_processed_block as sync_state_block,
  canonical.next_block as sync_state_next_block,
  canonical.latest_confirmed_block as sync_state_confirmed,
  canonical.last_processed_block_hash,
  canonical.last_processed_parent_hash,
  coalesce(observations.eligible_rows, 0) as eligible_observations,
  coalesce(observations.orphaned_rows, 0) as orphaned_observations,
  checkpoint_observation.confirmation_status as checkpoint_observation_status,
  (checkpoint_observation.block_hash is not null) as checkpoint_hash_row_exists
from public.contracts c
left join public.indexer_state legacy
  on legacy.chain_id = c.chain_id and legacy.contract_address = c.contract_address
left join public.indexer_sync_state canonical
  on canonical.chain_id = c.chain_id and canonical.contract_id = c.id
left join lateral (
  select
    count(*) filter (where b.confirmation_status in ('canonical', 'confirmed')) as eligible_rows,
    count(*) filter (where b.confirmation_status = 'orphaned') as orphaned_rows
  from public.indexed_blocks b
  where b.chain_id = c.chain_id
    and b.block_number <= greatest(
      coalesce(legacy.last_processed_block, 0),
      coalesce(canonical.last_processed_block, 0)
    )
) observations on true
left join public.indexed_blocks checkpoint_observation
  on checkpoint_observation.chain_id = c.chain_id
  and checkpoint_observation.block_number = canonical.last_processed_block
  and checkpoint_observation.block_hash = canonical.last_processed_block_hash
where c.chain_id = 11142220
order by c.contract_name;

-- Verify the intended composite primary key on indexed_blocks.
select pg_get_constraintdef(constraint_row.oid) as indexed_blocks_primary_key
from pg_constraint constraint_row
where constraint_row.conrelid = 'public.indexed_blocks'::regclass
  and constraint_row.contype = 'p';

-- Verify RLS is enabled and inspect role-level RLS bypass configuration.
select relation.relname, relation.relrowsecurity, relation.relforcerowsecurity
from pg_class relation
where relation.relnamespace = 'public'::regnamespace
  and relation.relname in (
    'blockchain_networks', 'contracts', 'indexed_blocks', 'indexed_transactions',
    'blockchain_events', 'blockchain_transactions', 'indexer_state',
    'indexer_sync_state', 'system_health'
  )
order by relation.relname;

select rolname, rolbypassrls
from pg_roles
where rolname in ('anon', 'authenticated', 'service_role')
order by rolname;

-- Verify the atomic commit function currently installed in production.
select pg_get_functiondef(
  'public.commit_indexer_checkpoint(integer,text,bigint,text,text,timestamp with time zone,bigint)'::regprocedure
);

-- Verify the deployment-boundary recovery function is installed.
select pg_get_functiondef(
  'public.rewind_indexer_checkpoint_to_deployment(integer,text,bigint)'::regprocedure
);