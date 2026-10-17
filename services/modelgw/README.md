# @pd/modelgw: Model gateway

Service skeleton (chat 1 PR 9). Plan: `docs/plans/09-repo-and-services.md` s4.7.

| Item | Value |
|---|---|
| Owner | @alwiarif46 (`.github/CODEOWNERS`) |
| Schema | `modelgw` |
| Postgres role | `modelgw_svc` (own schema only) |
| Env var for the database | `MODELGW_DATABASE_URL` |
| Default port | 4106 (`PORT` overrides) |
| Contract | `packages/contracts/openapi/modelgw.yaml` |

## What it owns

Provider adapters, rate buckets, metering, prompt cache layout, the reviewer-differs-from-drafter check.

## Tables it will get

- `ai_runs`
- `ai_settings`
- `provider_settings`
- `run_budgets`

Today the schema holds only `schema_migrations` and `outbox` (`migrations/0001_init.sql`). Each table
carries `tenant_id` with `FORCE ROW LEVEL SECURITY`. No foreign key crosses a schema.

## Run

```
pnpm --filter @pd/modelgw dev        # tsx watch, port 4106
pnpm --filter @pd/modelgw test
curl localhost:4106/healthz     # {"service":"modelgw","version":"0.1.0","schemaMigration":"none"}
```

`schemaMigration` is the latest id in `modelgw.schema_migrations`, `none` with no database configured,
and `unavailable` when the query fails. Run every query through `withTenant` from `@pd/service-kit`.

## TODO

- Outbox relay: the relay must read `modelgw.outbox` across tenants, which RLS forbids for the service
  role. Not solved here. Decision recorded in `docs/build/questions.md` (Chat 1): a separate relay
  role with BYPASSRLS limited to the outbox tables. Chats 2 and 3 build it.
- Real routes: add them to the OpenAPI file first, then to `src/routes.ts`.
