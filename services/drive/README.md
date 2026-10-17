# @pd/drive: Drive

Service skeleton (chat 1 PR 9). Plan: `docs/plans/09-repo-and-services.md` s4.14.

| Item | Value |
|---|---|
| Owner | @alwiarif46 (`.github/CODEOWNERS`) |
| Schema | `drive` |
| Postgres role | `drive_svc` (own schema only) |
| Env var for the database | `DRIVE_DATABASE_URL` |
| Default port | 4113 (`PORT` overrides) |
| Contract | `packages/contracts/openapi/drive.yaml` |

## What it owns

One Shaavir Drive folder per tenant, sharing, the Pink document and working documents, read-back of tenant edits.

## Tables it will get

- `drive_folders`
- `drive_documents`

Today the schema holds only `schema_migrations` and `outbox` (`migrations/0001_init.sql`). Each table
carries `tenant_id` with `FORCE ROW LEVEL SECURITY`. No foreign key crosses a schema.

## Run

```
pnpm --filter @pd/drive dev        # tsx watch, port 4113
pnpm --filter @pd/drive test
curl localhost:4113/healthz     # {"service":"drive","version":"0.1.0","schemaMigration":"none"}
```

`schemaMigration` is the latest id in `drive.schema_migrations`, `none` with no database configured,
and `unavailable` when the query fails. Run every query through `withTenant` from `@pd/service-kit`.

## TODO

- Outbox relay: the relay must read `drive.outbox` across tenants, which RLS forbids for the service
  role. Not solved here. Decision recorded in `docs/build/questions.md` (Chat 1): a separate relay
  role with BYPASSRLS limited to the outbox tables. Chats 2 and 3 build it.
- Real routes: add them to the OpenAPI file first, then to `src/routes.ts`.
