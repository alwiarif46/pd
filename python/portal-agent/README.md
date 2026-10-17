# e2e-portal-agent: Portal agent

Service skeleton (chat 1 PR 9). Plan: `docs/plans/09-repo-and-services.md` s4.13. Python 3.12, FastAPI, uv workspace member.

| Item | Value |
|---|---|
| Owner | @alwiarif46 (`.github/CODEOWNERS`, `/python/`) |
| Schema | `portal` |
| Postgres role | `portal_svc` (own schema only) |
| Env var for the database | `PORTAL_DATABASE_URL` |
| Default port | 4112 (`PORT` overrides) |
| Contract | `packages/contracts/openapi/portal.yaml`; `routes.json` mirrors its paths |

## What it owns

Portal sessions, the live view, per-session allow lists, downloads to the drop folder. No credential column exists. Model calls go through the model gateway.

## Tables it will get

- `portal_sessions`

Today the schema holds only `schema_migrations` and `outbox` (`migrations/0001_init.sql`, applied by `pnpm migrate`).

## Run

```
uv run portal-agent              # port 4112
uv run pytest python/portal-agent
curl localhost:4112/healthz
```

`schemaMigration` is the latest id in `portal.schema_migrations`, `none` with no database configured,
`unavailable` when the query fails.

## TODO

- Outbox relay: cross-tenant read of `portal.outbox` is not solved here. See `docs/build/questions.md`
  (Chat 1, outbox relay): option A, a separate relay role with BYPASSRLS limited to the outbox tables.
- Tenant context in Python: set `app.tenant_id` and `app.org_id` with `set_config(..., true)` inside a transaction, as `withTenant` does in `@pd/service-kit`.
- Real routes: add them to the OpenAPI file first, then `routes.py` and `routes.json`.
