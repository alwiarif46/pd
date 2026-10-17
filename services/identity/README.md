# @pd/identity: Identity and tenancy

Service skeleton (chat 1 PR 9). Plan: `docs/plans/09-repo-and-services.md` s4.2.

| Item | Value |
|---|---|
| Owner | @alwiarif46 (`.github/CODEOWNERS`) |
| Schema | `identity` |
| Postgres role | `identity_svc` (own schema only) |
| Env var for the database | `IDENTITY_DATABASE_URL` |
| Default port | 4101 (`PORT` overrides) |
| Contract | `packages/contracts/openapi/identity.yaml` |

## What it owns

Tenants and `tenant_id`, the Zitadel organization per tenant, the user mirror, memberships, roles, invites, SSO connection records, service tokens.

## Tables it will get

- `tenants`
- `users`
- `memberships`
- `invites`
- `sso_connections`
- `org_map`

Today the schema holds only `schema_migrations` and `outbox` (`migrations/0001_init.sql`). Each table
carries `tenant_id` with `FORCE ROW LEVEL SECURITY`. No foreign key crosses a schema.

## Run

```
pnpm --filter @pd/identity dev        # tsx watch, port 4101
pnpm --filter @pd/identity test
curl localhost:4101/healthz     # {"service":"identity","version":"0.1.0","schemaMigration":"none"}
```

`schemaMigration` is the latest id in `identity.schema_migrations`, `none` with no database configured,
and `unavailable` when the query fails. Run every query through `withTenant` from `@pd/service-kit`.

## TODO

- Outbox relay: the relay must read `identity.outbox` across tenants, which RLS forbids for the service
  role. Not solved here. Decision recorded in `docs/build/questions.md` (Chat 1): a separate relay
  role with BYPASSRLS limited to the outbox tables. Chats 2 and 3 build it.
- Real routes: add them to the OpenAPI file first, then to `src/routes.ts`.
