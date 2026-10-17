# @pd/orchestrator: Orchestrator

Service skeleton (chat 1 PR 9). Plan: `docs/plans/09-repo-and-services.md` s4.6.

| Item | Value |
|---|---|
| Owner | @alwiarif46 (`.github/CODEOWNERS`) |
| Schema | `orchestrator` |
| Postgres role | `orchestrator_svc` (own schema only) |
| Env var for the database | `ORCHESTRATOR_DATABASE_URL` |
| Default port | 4105 (`PORT` overrides) |
| Contract | `packages/contracts/openapi/orchestrator.yaml` |

## What it owns

The run state machine, stages, gates, resume, stage leases and run locks, the cost cap, the stage interface.

## Tables it will get

- `runs`
- `stages`
- `gates`
- `tool_calls`
- `run_artifacts`
- `cost_ledger`

Today the schema holds only `schema_migrations` and `outbox` (`migrations/0001_init.sql`). Each table
carries `tenant_id` with `FORCE ROW LEVEL SECURITY`. No foreign key crosses a schema.

## Run

```
pnpm --filter @pd/orchestrator dev        # tsx watch, port 4105
pnpm --filter @pd/orchestrator test
curl localhost:4105/healthz     # {"service":"orchestrator","version":"0.1.0","schemaMigration":"none"}
```

`schemaMigration` is the latest id in `orchestrator.schema_migrations`, `none` with no database configured,
and `unavailable` when the query fails. Run every query through `withTenant` from `@pd/service-kit`.

## TODO

- Outbox relay: the relay must read `orchestrator.outbox` across tenants, which RLS forbids for the service
  role. Not solved here. Decision recorded in `docs/build/questions.md` (Chat 1): a separate relay
  role with BYPASSRLS limited to the outbox tables. Chats 2 and 3 build it.
- Real routes: add them to the OpenAPI file first, then to `src/routes.ts`.
