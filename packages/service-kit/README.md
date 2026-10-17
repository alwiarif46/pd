# @pd/service-kit

Shared runtime for the TypeScript services (09 s2, s9).

| Export | What it does |
|---|---|
| `createServiceApp({ id, version, routes?, db?, logger? })` | Fastify app with `GET /healthz` returning `{ service, version, schemaMigration }`. `schemaMigration` is the latest id in `<schema>.schema_migrations`, `"none"` with no `db`, `"unavailable"` if the query fails or takes over 2 seconds. Never throws. |
| `startService({ id, build })` | Reads config, opens a pool when `<ID>_DATABASE_URL` is set, listens on the port. Used by each `src/index.ts`. |
| `loadServiceConfig(id, env?)` | `<ID>_DATABASE_URL`, `REDIS_URL`, `PORT`. |
| `withTenant(pool, tenantId, fn)` | Transaction with `app.tenant_id` and `app.org_id` set locally to the tenant uuid (09 s2, PD mapping). Same pattern as `withOrg` in `packages/core`. |
| `@pd/service-kit/migrate` | `applyMigrations`, `migrationServices`, `MIGRATION_ORDER`. See `infra/db/README.md`. Not loaded by running services. |

## Default ports

Gateway 3001 (PD's). The other 14 services take 4101 to 4114 in `packages/contracts/services.json` order:
identity 4101, billing 4102, ingest 4103, intel 4104, orchestrator 4105, modelgw 4106, drafting 4107, review 4108,
render 4109, evidence 4110, comms 4111, portal 4112, drive 4113, notify 4114. `PORT` overrides. A test keeps the table, `services.json` and every `.env.example` in step.

## Tests

`pnpm --filter @pd/service-kit test`. The database tests need `TEST_DATABASE_URL` (a superuser connection). Unset: they skip with a warning. Under `CI=true`: they fail. They create and drop their own database; the service roles are cluster-wide, so the tests hold a cluster advisory lock.

- `isolation.test.ts`: every role against every other service's `outbox` and `schema_migrations` (14 x 13 pairs, Postgres error 42501), `app.app_settings`, `public`.
- `migrate.test.ts`: order, idempotence, and a grep that no migration names another schema.
