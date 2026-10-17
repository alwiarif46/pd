# @pd/intel: Solicitation intel

Service skeleton (chat 1 PR 9). Plan: `docs/plans/09-repo-and-services.md` s4.5.

| Item | Value |
|---|---|
| Owner | @alwiarif46 (`.github/CODEOWNERS`) |
| Schema | `intel` |
| Postgres role | `intel_svc` (own schema only) |
| Env var for the database | `INTEL_DATABASE_URL` |
| Default port | 4104 (`PORT` overrides) |
| Contract | `packages/contracts/openapi/intel.yaml` |

## What it owns

Bids and the solicitation key, bid facts, shred, compliance matrix, quote matching, dates and schedule, amendment key check and diff, glossary and search terms, AI-ban check, bid/no-bid scores.

## Tables it will get

- `bids`
- `bid_facts`
- `compliance_rows`
- `schedule_activities`
- `amendments`
- `amendment_links`
- `outline_items`
- `production_items`
- `personnel_requirements`
- `glossary_terms`
- `search_terms`
- `bid_scores`
- `intake_items`
- `row_history`

Today the schema holds only `schema_migrations` and `outbox` (`migrations/0001_init.sql`). Each table
carries `tenant_id` with `FORCE ROW LEVEL SECURITY`. No foreign key crosses a schema.

## Run

```
pnpm --filter @pd/intel dev        # tsx watch, port 4104
pnpm --filter @pd/intel test
curl localhost:4104/healthz     # {"service":"intel","version":"0.1.0","schemaMigration":"none"}
```

`schemaMigration` is the latest id in `intel.schema_migrations`, `none` with no database configured,
and `unavailable` when the query fails. Run every query through `withTenant` from `@pd/service-kit`.

## TODO

- Outbox relay: the relay must read `intel.outbox` across tenants, which RLS forbids for the service
  role. Not solved here. Decision recorded in `docs/build/questions.md` (Chat 1): a separate relay
  role with BYPASSRLS limited to the outbox tables. Chats 2 and 3 build it.
- Real routes: add them to the OpenAPI file first, then to `src/routes.ts`.
