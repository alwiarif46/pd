-- identity: empty schema skeleton. Own schema only: no reference to any other schema (09 s9.3).
-- Roles are created by the migrate step before this file runs (identity_svc).
create schema if not exists identity;

create table if not exists identity.schema_migrations (
  id text primary key,
  applied_at timestamptz not null default now()
);

-- Events are written here in the same transaction as the change (09 s2).
create table if not exists identity.outbox (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  event_id uuid not null unique,
  type text not null,
  schema_version text not null,
  payload jsonb not null,
  occurred_at timestamptz not null default now(),
  published_at timestamptz null
);

create index if not exists outbox_unpublished_idx on identity.outbox (occurred_at) where published_at is null;

alter table identity.outbox enable row level security;
alter table identity.outbox force row level security;
drop policy if exists tenant_isolation on identity.outbox;
create policy tenant_isolation on identity.outbox
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Grants: the service's own role only. The ledger is read-only for the service.
revoke all on schema identity from public;
revoke all on all tables in schema identity from public;
grant usage on schema identity to identity_svc;
grant select on identity.schema_migrations to identity_svc;
grant select, insert, update, delete on identity.outbox to identity_svc;
alter default privileges in schema identity grant select, insert, update, delete on tables to identity_svc;
alter default privileges in schema identity grant usage, select on sequences to identity_svc;
