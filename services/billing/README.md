# @pd/billing: Billing

Service skeleton (chat 1 PR 9). Plan: `docs/plans/09-repo-and-services.md` s4.3.

| Item | Value |
|---|---|
| Owner | @alwiarif46 (`.github/CODEOWNERS`) |
| Schema | `billing` |
| Postgres role | `billing_svc` (own schema only) |
| Env var for the database | `BILLING_DATABASE_URL` |
| Default port | 4102 (`PORT` overrides) |
| Contract | `packages/contracts/openapi/billing.yaml` |

## What it owns

Plans, subscriptions, seats, proposal credits, recharges, font fees, Stripe webhooks, usage roll-ups for pricing.

## Tables it will get

- `subscriptions`
- `proposal_credits`
- `charges`
- `stripe_events`
- `run_usage`

Today the schema holds only `schema_migrations` and `outbox` (`migrations/0001_init.sql`). Each table
carries `tenant_id` with `FORCE ROW LEVEL SECURITY`. No foreign key crosses a schema.

## Run

```
pnpm --filter @pd/billing dev        # tsx watch, port 4102
pnpm --filter @pd/billing test
curl localhost:4102/healthz     # {"service":"billing","version":"0.1.0","schemaMigration":"none"}
```

`schemaMigration` is the latest id in `billing.schema_migrations`, `none` with no database configured,
and `unavailable` when the query fails. Run every query through `withTenant` from `@pd/service-kit`.

## TODO

- Outbox relay: the relay must read `billing.outbox` across tenants, which RLS forbids for the service
  role. Not solved here. Decision recorded in `docs/build/questions.md` (Chat 1): a separate relay
  role with BYPASSRLS limited to the outbox tables. Chats 2 and 3 build it.
- Real routes: add them to the OpenAPI file first, then to `src/routes.ts`.
