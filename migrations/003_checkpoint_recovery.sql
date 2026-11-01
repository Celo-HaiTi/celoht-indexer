-- Guard checkpoint commits against a missing legacy ledger row, and provide
-- an explicit, atomic recovery to the contract's official deployment block.

-- Repair only untouched bootstrap rows where the legacy ledger is seeded at
-- deployment - 1 and the canonical ledger still has its original zero cursor.
update public.indexer_sync_state canonical
set last_processed_block = legacy.last_processed_block,
    next_block = legacy.last_processed_block + 1,
    status = 'idle'
from public.contracts contract
join public.indexer_state legacy
  on legacy.chain_id = contract.chain_id
  and legacy.contract_address = contract.contract_address
where canonical.chain_id = contract.chain_id
  and canonical.contract_id = contract.id
  and contract.deployment_block > 0
  and legacy.last_processed_block = contract.deployment_block - 1
  and legacy.latest_confirmed_block is null
  and canonical.last_processed_block = 0
  and canonical.next_block = contract.deployment_block
  and canonical.last_processed_block_hash is null
  and canonical.last_processed_parent_hash is null
  and canonical.latest_confirmed_block is null
  and not exists (
    select 1 from public.indexed_blocks block
    where block.chain_id = contract.chain_id
      and block.block_number <= legacy.last_processed_block
      and block.confirmation_status in ('canonical', 'confirmed')
  );

create or replace function public.commit_indexer_checkpoint(
  p_chain_id integer,
  p_contract_address text,
  p_block_number bigint,
  p_block_hash text,
  p_parent_hash text,
  p_block_time timestamptz,
  p_latest_confirmed_block bigint
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_contract_id uuid;
  v_rows integer;
begin
  select id into v_contract_id
  from public.contracts
  where chain_id = p_chain_id
    and contract_address = p_contract_address;

  if v_contract_id is null then
    raise exception 'Unknown indexer contract % on chain %', p_contract_address, p_chain_id;
  end if;
  if p_block_number < 0 or p_latest_confirmed_block < 0 then
    raise exception 'Checkpoint block numbers must be nonnegative';
  end if;

  insert into public.indexed_blocks (
    chain_id, block_number, block_hash, parent_hash, block_time, confirmed_at, confirmation_status
  ) values (
    p_chain_id, p_block_number, p_block_hash, p_parent_hash, p_block_time, now(), 'canonical'
  )
  on conflict (chain_id, block_number, block_hash) do update set
    parent_hash = excluded.parent_hash,
    block_time = excluded.block_time,
    confirmed_at = excluded.confirmed_at,
    confirmation_status = excluded.confirmation_status;

  update public.indexer_state
  set last_processed_block = p_block_number,
      latest_confirmed_block = p_latest_confirmed_block,
      sync_status = 'syncing',
      last_successful_sync_at = now(),
      last_error = null
  where chain_id = p_chain_id
    and contract_address = p_contract_address;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'Expected one legacy checkpoint for contract % on chain %, updated %',
      p_contract_address, p_chain_id, v_rows;
  end if;

  update public.indexer_sync_state
  set next_block = p_block_number + 1,
      last_processed_block = p_block_number,
      last_processed_block_hash = p_block_hash,
      last_processed_parent_hash = p_parent_hash,
      latest_confirmed_block = p_latest_confirmed_block,
      status = 'idle',
      last_success_at = now(),
      last_error = null
  where chain_id = p_chain_id
    and contract_id = v_contract_id;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'Expected one canonical checkpoint for contract % on chain %, updated %',
      p_contract_address, p_chain_id, v_rows;
  end if;
end;
$$;

create or replace function public.rewind_indexer_checkpoint_to_deployment(
  p_chain_id integer,
  p_contract_address text,
  p_deployment_block bigint
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_contract_id uuid;
  v_official_deployment bigint;
  v_checkpoint bigint;
  v_seed_block bigint;
  v_rows integer;
begin
  select id, deployment_block into v_contract_id, v_official_deployment
  from public.contracts
  where chain_id = p_chain_id
    and contract_address = p_contract_address
  for update;

  if v_contract_id is null then
    raise exception 'Unknown indexer contract % on chain %', p_contract_address, p_chain_id;
  end if;
  if p_deployment_block < 0 then
    raise exception 'Deployment block must be nonnegative';
  end if;
  if v_official_deployment <> p_deployment_block then
    raise exception 'Recovery deployment block % does not match official block % for contract %',
      p_deployment_block, v_official_deployment, p_contract_address;
  end if;

  select last_processed_block into v_checkpoint
  from public.indexer_sync_state
  where chain_id = p_chain_id and contract_id = v_contract_id
  for update;
  if v_checkpoint is null then
    raise exception 'Missing canonical checkpoint for contract % on chain %', p_contract_address, p_chain_id;
  end if;

  if exists (
    select 1 from public.indexed_blocks
    where chain_id = p_chain_id
      and block_number <= v_checkpoint
      and confirmation_status in ('canonical', 'confirmed')
  ) then
    raise exception 'Deployment recovery refused while eligible canonical anchors exist for contract %',
      p_contract_address;
  end if;

  v_seed_block := greatest(0, p_deployment_block - 1);

  update public.indexer_state
  set last_processed_block = v_seed_block,
      latest_confirmed_block = null,
      sync_status = 'syncing',
      last_error = null
  where chain_id = p_chain_id and contract_address = p_contract_address;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'Expected one legacy checkpoint for contract % on chain %, updated %',
      p_contract_address, p_chain_id, v_rows;
  end if;

  update public.indexer_sync_state
  set next_block = p_deployment_block,
      last_processed_block = v_seed_block,
      safe_block = null,
      last_processed_block_hash = null,
      last_processed_parent_hash = null,
      latest_confirmed_block = null,
      status = 'syncing',
      last_error = null
  where chain_id = p_chain_id and contract_id = v_contract_id;
  get diagnostics v_rows = row_count;
  if v_rows <> 1 then
    raise exception 'Expected one canonical checkpoint for contract % on chain %, updated %',
      p_contract_address, p_chain_id, v_rows;
  end if;
end;
$$;

revoke all on function public.commit_indexer_checkpoint(integer, text, bigint, text, text, timestamptz, bigint) from public;
revoke all on function public.rewind_indexer_checkpoint_to_deployment(integer, text, bigint) from public;
do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'blockchain_networks', 'contracts', 'indexed_blocks', 'indexed_transactions',
    'blockchain_events', 'blockchain_transactions', 'indexer_state',
    'indexer_sync_state', 'system_health'
  ] loop
    if to_regclass(format('public.%I', v_table)) is not null then
      execute format('alter table public.%I enable row level security', v_table);
      execute format('revoke insert, update, delete, truncate, references, trigger on table public.%I from public', v_table);
      if exists (select 1 from pg_roles where rolname = 'anon') then
        execute format('revoke insert, update, delete, truncate, references, trigger on table public.%I from anon', v_table);
      end if;
      if exists (select 1 from pg_roles where rolname = 'authenticated') then
        execute format('revoke insert, update, delete, truncate, references, trigger on table public.%I from authenticated', v_table);
      end if;
      if exists (select 1 from pg_roles where rolname = 'service_role') then
        execute format('grant select, insert, update, delete on table public.%I to service_role', v_table);
      end if;
    end if;
  end loop;

  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.commit_indexer_checkpoint(integer, text, bigint, text, text, timestamptz, bigint) from anon';
    execute 'revoke all on function public.rewind_indexer_checkpoint_to_deployment(integer, text, bigint) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.commit_indexer_checkpoint(integer, text, bigint, text, text, timestamptz, bigint) from authenticated';
    execute 'revoke all on function public.rewind_indexer_checkpoint_to_deployment(integer, text, bigint) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.commit_indexer_checkpoint(integer, text, bigint, text, text, timestamptz, bigint) to service_role';
    execute 'grant execute on function public.rewind_indexer_checkpoint_to_deployment(integer, text, bigint) to service_role';
  end if;
end;
$$;