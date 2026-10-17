-- billing: empty schema skeleton. Own schema only: no reference to any other schema (09 s9.3).
-- Roles are created by the migrate step before this file runs (billing_svc).
create schema if not exists billing;

create table if not exists billing.schema_migrations (
  id text primary key,
  applied_at timestamptz not null default now()
);

-- Events are written here in the same transaction as the change (09 s2).
create table if not exists billing.outbox (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  event_id uuid not null unique,
  type text not null,
  schema_version text not null,
  payload jsonb not null,
  occurred_at timestamptz not null default now(),
  published_at timestamptz null
);

create index if not exists outbox_unpublished_idx on billing.outbox (occurred_at) where published_at is null;

alter table billing.outbox enable row level security;
alter table billing.outbox force row level security;
drop policy if exists tenant_isolation on billing.outbox;
create policy tenant_isolation on billing.outbox
  for all
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Grants: the service's own role only. The ledger is read-only for the service.
revoke all on schema billing from public;
revoke all on all tables in schema billing from public;
grant usage on schema billing to billing_svc;
grant select on billing.schema_migrations to billing_svc;
grant select, insert, update, delete on billing.outbox to billing_svc;
alter default privileges in schema billing grant select, insert, update, delete on tables to billing_svc;
alter default privileges in schema billing grant usage, select on sequences to billing_svc;
