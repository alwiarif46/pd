# @pd/evidence: Evidence and repository

Service skeleton (chat 1 PR 9). Plan: `docs/plans/09-repo-and-services.md` s4.11.

| Item | Value |
|---|---|
| Owner | @alwiarif46 (`.github/CODEOWNERS`) |
| Schema | `evidence` |
| Postgres role | `evidence_svc` (own schema only) |
| Env var for the database | `EVIDENCE_DATABASE_URL` |
| Default port | 4110 (`PORT` overrides) |
| Contract | `packages/contracts/openapi/evidence.yaml` |

## What it owns

Evidence documents, contracts, evidence items, the needs register, repository items with pgvector embeddings, intake fetch, outcomes, learning events, gate calibration, the internal evidence API for ledger scripts.

## Tables it will get

- `evidence_documents`
- `contracts`
- `evidence_items`
- `needs_register`
- `repo_items`
- `repo_embeddings`
- `candidates`
- `resume_matches`
- `outcomes`
- `learning_events`
- `gate_calibration`

Today the schema holds only `schema_migrations` and `outbox` (`migrations/0001_init.sql`). Each table
carries `tenant_id` with `FORCE ROW LEVEL SECURITY`. No foreign key crosses a schema.

## Run

```
pnpm --filter @pd/evidence dev        # tsx watch, port 4110
pnpm --filter @pd/evidence test
curl localhost:4110/healthz     # {"service":"evidence","version":"0.1.0","schemaMigration":"none"}
```

`schemaMigration` is the latest id in `evidence.schema_migrations`, `none` with no database configured,
and `unavailable` when the query fails. Run every query through `withTenant` from `@pd/service-kit`.

## TODO

- Outbox relay: the relay must read `evidence.outbox` across tenants, which RLS forbids for the service
  role. Not solved here. Decision recorded in `docs/build/questions.md` (Chat 1): a separate relay
  role with BYPASSRLS limited to the outbox tables. Chats 2 and 3 build it.
- Real routes: add them to the OpenAPI file first, then to `src/routes.ts`.
