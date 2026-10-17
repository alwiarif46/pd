-- intel: empty schema skeleton. Own schema only: no reference to any other schema (09 s9.3).
-- Roles are created by the migrate step before this file runs (intel_svc).
create schema if not exists intel;

create table if not exists intel.schema_migrations (
  id text primary key,
  applied_at timestamptz not null default now()
);

-- Events are written here in the same transaction as the change (09 s2).
create table if not exists intel.outbox (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  event_id uuid not null unique,
  type text not null,
  schema_version text not null,
  payload jsonb not null,
  occurred_at timestamptz not null default now(),
  published_at timestamptz null
);

create index if not exists outbox_unpublished_idx on intel.outbox (occurred_at) where published_at is null;

alter table intel.outbox enable row level security;
alter table intel.outbox force row level security;
drop policy if exists tenant_isolation on intel.outbox;
create policy tenant_isolation on intel.outbox
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Grants: the service's own role only. The ledger is read-only for the service.
revoke all on schema intel from public;
revoke all on all tables in schema intel from public;
grant usage on schema intel to intel_svc;
grant select on intel.schema_migrations to intel_svc;
grant select, insert, update, delete on intel.outbox to intel_svc;
alter default privileges in schema intel grant select, insert, update, delete on tables to intel_svc;
alter default privileges in schema intel grant usage, select on sequences to intel_svc;
