# @pd/ingest: Ingest

Service skeleton (chat 1 PR 9). Plan: `docs/plans/09-repo-and-services.md` s4.4.

| Item | Value |
|---|---|
| Owner | @alwiarif46 (`.github/CODEOWNERS`) |
| Schema | `ingest` |
| Postgres role | `ingest_svc` (own schema only) |
| Env var for the database | `INGEST_DATABASE_URL` |
| Default port | 4103 (`PORT` overrides) |
| Contract | `packages/contracts/openapi/ingest.yaml` |

## What it owns

Uploads, upload sessions, documents, solicitation pages, ClamAV scan, sandbox convert, text extraction, OCR, marking check, classify, chunk, pre-scan, file retention. The nested package `sandbox/` is PD's sandbox and is not part of this skeleton.

## Tables it will get

- `documents`
- `upload_sessions`
- `pages`
- `archive_objects`
- `jobs`
- `exports`

Today the schema holds only `schema_migrations` and `outbox` (`migrations/0001_init.sql`). Each table
carries `tenant_id` with `FORCE ROW LEVEL SECURITY`. No foreign key crosses a schema.

## Run

```
pnpm --filter @pd/ingest dev        # tsx watch, port 4103
pnpm --filter @pd/ingest test
curl localhost:4103/healthz     # {"service":"ingest","version":"0.1.0","schemaMigration":"none"}
```

`schemaMigration` is the latest id in `ingest.schema_migrations`, `none` with no database configured,
and `unavailable` when the query fails. Run every query through `withTenant` from `@pd/service-kit`.

## TODO

- Outbox relay: the relay must read `ingest.outbox` across tenants, which RLS forbids for the service
  role. Not solved here. Decision recorded in `docs/build/questions.md` (Chat 1): a separate relay
  role with BYPASSRLS limited to the outbox tables. Chats 2 and 3 build it.
- Real routes: add them to the OpenAPI file first, then to `src/routes.ts`.
