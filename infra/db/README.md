# infra/db

How the Postgres cluster is laid out for the 15 services (09 s2, s9.3). Code: `packages/service-kit/src/migrate.ts`. Run it with `pnpm migrate`.

## Layout

| Schema | Owner role | Notes |
|---|---|---|
| `app` | the admin (migrator) | Shared settings: `app.app_settings`, `app.schema_migrations`. No service role has any access. |
| `identity`, `billing`, `ingest`, `intel`, `orchestrator`, `modelgw`, `drafting`, `review`, `render`, `evidence`, `comms`, `portal`, `drive`, `notify` | the admin | One schema per service with its own login role `<schema>_svc`. The gateway has no schema. |

Each service schema holds `schema_migrations`, `outbox` (RLS forced, policy on `app.tenant_id`), a read-only `app_settings` view over `app.app_settings`, and the service's own tables later.

## `pnpm migrate`

```
PD_ADMIN_DATABASE_URL=postgres://postgres@127.0.0.1:5432/pd \
IDENTITY_DB_PASSWORD=... BILLING_DB_PASSWORD=... pnpm migrate [service ...]
```

- `PD_ADMIN_DATABASE_URL`: a role that can create roles and schemas. Required.
- `<SERVICE>_DB_PASSWORD` (`IDENTITY_DB_PASSWORD`, `MODELGW_DB_PASSWORD`, `PORTAL_DB_PASSWORD`, ...): the login password of that service's role. Without it the role is created `NOLOGIN` (an existing role keeps its current password). Put the same password in the service's `<SERVICE>_DATABASE_URL`.
- Service ids on the command line limit the run to those services. The `app` step and their roles still run.

Order (fixed): `app`, `identity`, `billing`, `ingest`, `intel`, `orchestrator`, `modelgw`, `drafting`, `review`, `render`, `evidence`, `comms`, `portal`, `drive`, `notify`.

Steps, in one run, under one advisory lock per database:

1. Roles. For each service, create `<schema>_svc` if missing (`NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`), set `LOGIN` and the password when one is given, set `search_path` to its schema, and `REVOKE ALL ON SCHEMA public` from the role and from `PUBLIC`. (PD's own migration already revokes `public` from `PUBLIC` and grants `pd_app` by name.)
2. The `app` schema: `infra/db/app/*.sql`, recorded in `app.schema_migrations`.
3. In every service schema: create the schema if missing, create or replace the view `app_settings` (owner rights, so the role needs nothing on `app`), `GRANT SELECT` on it to the service role only.
4. For each service in order: `<folder>/migrations/*.sql` in filename order. Each file runs in a transaction with its row in `<schema>.schema_migrations(id, applied_at)`. Applied files are skipped, so a rerun changes nothing.

## Rules for migration files

- A migration touches its own schema only. No `<otherschema>.` anywhere in the SQL; a unit test checks every file.
- Every migration set starts from `0001_init.sql`: schema, `schema_migrations`, `outbox` with RLS, and grants to the service's own role.
- `GRANT` and `REVOKE` for the role are in the migration, so the role must exist first. `pnpm migrate` guarantees that.
- No passwords or secrets in SQL or in git.

## Not solved yet

The outbox relay must read every tenant's rows, which RLS blocks for the service role. Decision (option A, a separate BYPASSRLS relay role limited to the outbox tables) is in `docs/build/questions.md`, Chat 1. Chats 2 and 3 build it.
