-- CeloHT indexer-owned schema. Apply with the same least-privilege writer
-- role used by the indexer. Blockchain identifiers remain text to preserve
-- uint256 values exactly and avoid JavaScript number truncation.

create extension if not exists pgcrypto;

create table if not exists blockchain_networks (
  chain_id bigint primary key,
  network text not null unique,
  native_symbol text not null default 'CELO',
  is_enabled boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists contracts (
  id uuid primary key default gen_random_uuid(),
  chain_id bigint not null references blockchain_networks(chain_id),
  contract_name text not null,
  contract_address text not null,
  deployment_block bigint not null check (deployment_block >= 0),
  metadata_ref text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (chain_id, contract_address)
);

create table if not exists indexed_blocks (
  chain_id bigint not null,
  block_number bigint not null check (block_number >= 0),
  block_hash text not null,
  parent_hash text,
  block_time timestamptz,
  confirmed_at timestamptz,
  primary key (chain_id, block_number),
  unique (chain_id, block_hash)
);

create table if not exists indexed_transactions (
  id uuid primary key default gen_random_uuid(),
  chain_id bigint not null,
  transaction_hash text not null,
  block_number bigint not null,
  block_hash text not null,
  transaction_index integer,
  confirmation_status text not null default 'confirmed',
  created_at timestamptz not null default now(),
  unique (chain_id, transaction_hash)
);

create table if not exists blockchain_events (
  id uuid primary key default gen_random_uuid(),
  chain_id bigint not null,
  contract_id uuid not null references contracts(id),
  transaction_id uuid references indexed_transactions(id),
  block_number bigint not null,
  block_hash text not null,
  parent_hash text,
  transaction_hash text not null,
  transaction_index integer,
  log_index integer not null,
  contract_address text not null,
  event_name text not null,
  event_type text not null,
  block_timestamp timestamptz,
  event_data jsonb not null,
  confirmation_status text not null default 'confirmed',
  created_at timestamptz not null default now(),
  unique (chain_id, transaction_hash, log_index)
);

create table if not exists blockchain_transactions (
  id uuid primary key default gen_random_uuid(),
  chain_id bigint not null,
  contract_address text not null,
  transaction_hash text not null,
  log_index integer not null,
  block_number bigint not null,
  block_hash text not null,
  transaction_index integer,
  event_name text not null,
  event_data jsonb not null,
  confirmed boolean not null default false,
  created_at timestamptz not null default now(),
  unique (chain_id, transaction_hash, log_index)
);

create table if not exists token_transfers (
  id uuid primary key default gen_random_uuid(),
  chain_id bigint not null,
  token_address text not null,
  blockchain_transaction_id uuid,
  transaction_hash text not null,
  log_index integer not null,
  block_number bigint not null,
  block_hash text not null,
  transaction_index integer,
  from_address text not null,
  to_address text not null,
  amount text not null,
  asset_symbol text not null,
  confirmation_status text not null default 'confirmed',
  created_at timestamptz not null default now(),
  unique (chain_id, transaction_hash, log_index)
);

create table if not exists agent_events (like blockchain_events including defaults);
create table if not exists service_payment_events (like blockchain_events including defaults);
create table if not exists education_events (like blockchain_events including defaults);
create table if not exists reforestation_events (like blockchain_events including defaults);
create table if not exists governance_events (like blockchain_events including defaults);

create table if not exists indexer_state (
  id uuid primary key default gen_random_uuid(),
  chain_id bigint not null,
  contract_name text not null,
  contract_address text not null,
  last_processed_block bigint not null default 0,
  latest_confirmed_block bigint,
  sync_status text not null default 'idle',
  last_successful_sync_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  unique (chain_id, contract_address)
);

create table if not exists indexer_sync_state (
  id uuid primary key default gen_random_uuid(),
  chain_id bigint not null,
  contract_id uuid not null references contracts(id),
  next_block bigint not null,
  latest_confirmed_block bigint,
  status text not null default 'idle',
  last_success_at timestamptz,
  last_error text,
  unique (chain_id, contract_id)
);

create index if not exists indexed_blocks_chain_number_idx on indexed_blocks(chain_id, block_number desc);
create index if not exists blockchain_events_contract_block_idx on blockchain_events(chain_id, contract_id, block_number);
create index if not exists blockchain_events_event_name_idx on blockchain_events(chain_id, event_name);
create index if not exists token_transfers_token_block_idx on token_transfers(chain_id, token_address, block_number);
create index if not exists indexer_state_status_idx on indexer_state(chain_id, sync_status);
create unique index if not exists agent_events_identity_idx on agent_events(chain_id, transaction_hash, log_index);
create unique index if not exists service_payment_events_identity_idx on service_payment_events(chain_id, transaction_hash, log_index);
create unique index if not exists education_events_identity_idx on education_events(chain_id, transaction_hash, log_index);
create unique index if not exists reforestation_events_identity_idx on reforestation_events(chain_id, transaction_hash, log_index);
create unique index if not exists governance_events_identity_idx on governance_events(chain_id, transaction_hash, log_index);

-- These columns are added for installations that predate this migration.
alter table if exists blockchain_transactions add column if not exists transaction_index integer;
alter table if exists indexed_transactions add column if not exists transaction_index integer;
alter table if exists indexed_blocks add column if not exists parent_hash text;
alter table if exists blockchain_events add column if not exists parent_hash text;
alter table if exists blockchain_events add column if not exists transaction_index integer;
alter table if exists blockchain_events add column if not exists contract_address text;
