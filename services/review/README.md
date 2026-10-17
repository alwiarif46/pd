# @pd/review: Review

Service skeleton (chat 1 PR 9). Plan: `docs/plans/09-repo-and-services.md` s4.9.

| Item | Value |
|---|---|
| Owner | @alwiarif46 (`.github/CODEOWNERS`) |
| Schema | `review` |
| Postgres role | `review_svc` (own schema only) |
| Env var for the database | `REVIEW_DATABASE_URL` |
| Default port | 4108 (`PORT` overrides) |
| Contract | `packages/contracts/openapi/review.yaml` |

## What it owns

Red review on the reviewer model, Gold Team, White Glove, findings, dispositions, predicted factor ratings, the round diff.

## Tables it will get

- `reviews`
- `review_findings`
- `dispositions`
- `factor_ratings`

Today the schema holds only `schema_migrations` and `outbox` (`migrations/0001_init.sql`). Each table
carries `tenant_id` with `FORCE ROW LEVEL SECURITY`. No foreign key crosses a schema.

## Run

```
pnpm --filter @pd/review dev        # tsx watch, port 4108
pnpm --filter @pd/review test
curl localhost:4108/healthz     # {"service":"review","version":"0.1.0","schemaMigration":"none"}
```

`schemaMigration` is the latest id in `review.schema_migrations`, `none` with no database configured,
and `unavailable` when the query fails. Run every query through `withTenant` from `@pd/service-kit`.

## TODO

- Outbox relay: the relay must read `review.outbox` across tenants, which RLS forbids for the service
  role. Not solved here. Decision recorded in `docs/build/questions.md` (Chat 1): a separate relay
  role with BYPASSRLS limited to the outbox tables. Chats 2 and 3 build it.
- Real routes: add them to the OpenAPI file first, then to `src/routes.ts`.
