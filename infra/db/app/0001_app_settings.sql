-- The shared `app` schema (09 s9.3, 03 s12). Service roles get no access to it. Each service
-- schema gets a read-only view `app_settings` over this table, created by migrate.ts.
create schema if not exists app;

create table if not exists app.schema_migrations (
  id text primary key,
  applied_at timestamptz not null default now()
);

create table if not exists app.app_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
