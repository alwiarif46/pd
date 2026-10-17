# @pd/service-kit

Shared runtime for the TypeScript services (09 s2, s9).

| Export | What it does |
|---|---|
| `createServiceApp({ id, version, routes?, db?, logger? })` | Fastify app with `GET /healthz` returning `{ service, version, schemaMigration }`. `schemaMigration` is the latest id in `<schema>.schema_migrations`, `"none"` with no `db`, `"unavailable"` if the query fails or takes over 2 seconds. Never throws. |
| `startService({ id, build })` | Reads config, opens a pool when `<ID>_DATABASE_URL` is set, listens on the port. Used by each `src/index.ts`. |
| `loadServiceConfig(id, env?)` | `<ID>_DATABASE_URL`, `REDIS_URL`, `PORT`. |
| `withTenant(pool, tenantId, fn)` | Transaction with `app.tenant_id` and `app.org_id` set locally to the tenant uuid (09 s2, PD mapping). Same pattern as `withOrg` in `packages/core`. |
| `relayOnce(pool, redis, { schema, streamPrefix }, { batchSize? })`, `relayAll`, `relayTargets` | Outbox relay. Claims unpublished rows with `FOR UPDATE SKIP LOCKED`, `XADD`s each to `<stream_prefix>.<type>` (a `type` that starts with the service id, such as `review.red.delivered`, does not repeat it), then sets `published_at`. At least once: consumers dedupe on `event_id`. `redis` is injected (`xadd(stream, '*', ...fields)`); tests use a fake. Connect the pool as `outbox_relay`. |
| `outboxChannel`, `assertOwnChannel`, `listenOnOutbox`, `notifyOutbox` | LISTEN/NOTIFY channels. A service's channel is `<schema>_outbox`; any channel must start with `<schema>_`. |
| `tenantRlsSql(schema, table)`, `applyTenantRls` | The RLS template: ENABLE and FORCE row level security plus the `tenant_isolation` policy on `app.tenant_id`. Idempotent. |
| `@pd/service-kit/migrate` | `applyMigrations`, `migrationServices`, `MIGRATION_ORDER`, `RELAY_ROLE`. See `infra/db/README.md`. Not loaded by running services. |

## Default ports

Gateway 3001 (PD's). The other 14 services take 4101 to 4114 in `packages/contracts/services.json` order:
identity 4101, billing 4102, ingest 4103, intel 4104, orchestrator 4105, modelgw 4106, drafting 4107, review 4108,
render 4109, evidence 4110, comms 4111, portal 4112, drive 4113, notify 4114. `PORT` overrides. A test keeps the table, `services.json` and every `.env.example` in step.

## Tests

`pnpm --filter @pd/service-kit test`. The database tests need `TEST_DATABASE_URL` (a superuser connection). Unset: they skip with a warning. Under `CI=true`: they fail.

- **Disposable cluster only.** The guard runs once per `vitest run` in `test/global-setup.ts` (a per-file check would trip on roles an earlier file created). The tests call `applyMigrations` with random passwords, which resets the password of the cluster-wide `<schema>_svc` roles. If any of the 14 already has a login password, the tests refuse to run: they skip with a loud warning, and fail under `CI=true`. Set `SERVICE_KIT_TEST_RESETS_ROLES=1` to say resetting them is fine (a local dev cluster whose service passwords you can set again). A fresh CI Postgres passes the guard without it.
- Each file creates a database owned by a throwaway `sk_admin_<rand>` role (`CREATEROLE CREATEDB NOSUPERUSER NOBYPASSRLS`), migrates as that role, and drops both after. The 14 roles live in the cluster, so the tests hold a cluster advisory lock.
- `healthz` reads the ledger with `set local statement_timeout = 2000` in the same message, so the server cancels a slow query; the 2 second race stays as the backstop. Pools do not get a global statement timeout.

- `isolation.test.ts`: every role against every other service's `outbox` and `schema_migrations` (14 x 13 pairs, Postgres error 42501), `app.app_settings`, `public`.
- `owner-rls.test.ts`: FORCE RLS holds for the table owner; a guard that every service table except `schema_migrations` has RLS enabled and forced (allow-list in the test); `CONNECT` privileges.
- `scram.test.ts`: the SCRAM-SHA-256 verifier equals the one Postgres stores for the same salt and iterations.
- `migrate.test.ts`: order, idempotence, and a grep that no migration names another schema or sets `search_path`.

## The outbox relay exception to rule 4

CLAUDE.md rule 4 says every query runs inside `withTenant`. The one written exception is the `outbox_relay` role, which the relay helper uses. It reads every tenant's unpublished `<schema>.outbox` rows and sets `published_at`. The migrate step creates it (SCRAM verifier from `OUTBOX_RELAY_DB_PASSWORD`, never plain text) and grants it `CONNECT`, `USAGE` on each service schema, `SELECT` on each outbox and `UPDATE (published_at)`. It has no other table, no ledger, no `app` schema and no `CREATE`. No service role uses it, and no service code outside the relay may connect as it. `relay-role.test.ts` proves it cannot select, insert, delete or update anything else.

## LISTEN/NOTIFY channels

Postgres has no ACL on channels, so this is a convention that review enforces. A service listens and notifies only on channels that start with `<schema>_`, for example `billing_outbox`. Use `listenOnOutbox` and `notifyOutbox`, which reject any other name. The relay may listen on each service's own `<schema>_outbox`. Send `NOTIFY` after the outbox row commits, and treat it as a hint only: the relay still polls.

## RLS template and drift guard

Every new table gets `tenantRlsSql(schema, table)` (paste its output into the migration). `rls.test.ts` fails when any table in a service schema, except `schema_migrations` and the allow-list, lacks ENABLE, FORCE, a `tenant_id` column or a policy on `app.tenant_id`.
