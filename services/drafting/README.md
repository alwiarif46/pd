# @pd/drafting: Drafting

Service skeleton (chat 1 PR 9). Plan: `docs/plans/09-repo-and-services.md` s4.8.

| Item | Value |
|---|---|
| Owner | @alwiarif46 (`.github/CODEOWNERS`) |
| Schema | `drafting` |
| Postgres role | `drafting_svc` (own schema only) |
| Env var for the database | `DRAFTING_DATABASE_URL` |
| Default port | 4107 (`PORT` overrides) |
| Contract | `packages/contracts/openapi/drafting.yaml` |

## What it owns

Worksheet, outline, volumes, sections, the Blank Register, draft pages, blocks and block locks, block versions, change proposals, page checks, the 90% page gate, strengths, claims, citations, visuals, vignettes, NEEDs.

## Tables it will get

- `volumes`
- `proposal_sections`
- `blanks`
- `draft_pages`
- `blocks`
- `block_versions`
- `change_proposals`
- `page_checks`
- `strengths`
- `claims`
- `citations`
- `visuals`
- `evidence_links`
- `vignettes`
- `needs`

Today the schema holds only `schema_migrations` and `outbox` (`migrations/0001_init.sql`). Each table
carries `tenant_id` with `FORCE ROW LEVEL SECURITY`. No foreign key crosses a schema.

## Run

```
pnpm --filter @pd/drafting dev        # tsx watch, port 4107
pnpm --filter @pd/drafting test
curl localhost:4107/healthz     # {"service":"drafting","version":"0.1.0","schemaMigration":"none"}
```

`schemaMigration` is the latest id in `drafting.schema_migrations`, `none` with no database configured,
and `unavailable` when the query fails. Run every query through `withTenant` from `@pd/service-kit`.

## TODO

- Outbox relay: the relay must read `drafting.outbox` across tenants, which RLS forbids for the service
  role. Not solved here. Decision recorded in `docs/build/questions.md` (Chat 1): a separate relay
  role with BYPASSRLS limited to the outbox tables. Chats 2 and 3 build it.
- Real routes: add them to the OpenAPI file first, then to `src/routes.ts`.
