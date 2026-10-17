# @pd/notify: Notifications and audit

Service skeleton (chat 1 PR 9). Plan: `docs/plans/09-repo-and-services.md` s4.15.

| Item | Value |
|---|---|
| Owner | @alwiarif46 (`.github/CODEOWNERS`) |
| Schema | `notify` |
| Postgres role | `notify_svc` (own schema only) |
| Env var for the database | `NOTIFY_DATABASE_URL` |
| Default port | 4114 (`PORT` overrides) |
| Contract | `packages/contracts/openapi/notify.yaml` |

## What it owns

In-app notifications, email notifications, alerts and deadlines, the append-only audit log.

## Tables it will get

- `notifications`
- `alerts`
- `audit_log`

Today the schema holds only `schema_migrations` and `outbox` (`migrations/0001_init.sql`). Each table
carries `tenant_id` with `FORCE ROW LEVEL SECURITY`. No foreign key crosses a schema.

## Run

```
pnpm --filter @pd/notify dev        # tsx watch, port 4114
pnpm --filter @pd/notify test
curl localhost:4114/healthz     # {"service":"notify","version":"0.1.0","schemaMigration":"none"}
```

`schemaMigration` is the latest id in `notify.schema_migrations`, `none` with no database configured,
and `unavailable` when the query fails. Run every query through `withTenant` from `@pd/service-kit`.

## TODO

- Outbox relay: the relay must read `notify.outbox` across tenants, which RLS forbids for the service
  role. Not solved here. Decision recorded in `docs/build/questions.md` (Chat 1): a separate relay
  role with BYPASSRLS limited to the outbox tables. Chats 2 and 3 build it.
- Real routes: add them to the OpenAPI file first, then to `src/routes.ts`.
