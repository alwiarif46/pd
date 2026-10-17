# e2e-render: Render

Service skeleton (chat 1 PR 9). Plan: `docs/plans/09-repo-and-services.md` s4.10. Python 3.12, FastAPI, uv workspace member.

| Item | Value |
|---|---|
| Owner | @alwiarif46 (`.github/CODEOWNERS`, `/python/`) |
| Schema | `render` |
| Postgres role | `render_svc` (own schema only) |
| Env var for the database | `RENDER_DATABASE_URL` |
| Default port | 4109 (`PORT` overrides) |
| Contract | `packages/contracts/openapi/render.yaml`; `routes.json` mirrors its paths |

## What it owns

The toolrunner and script containers, the format lock stage, format specs and shells, fonts and font requests, python-docx assembly, code-computed numbering, DOCX to PDF, rasterize, page geometry, page count, packages.

## Tables it will get

- `format_specs`
- `client_shells`
- `tenant_fonts`
- `font_requests`
- `renders`
- `render_issues`
- `packages`
- `package_files`
- `signature_items`

Today the schema holds only `schema_migrations` and `outbox` (`migrations/0001_init.sql`, applied by `pnpm migrate`).

## Run

```
uv run render              # port 4109
uv run pytest python/render
curl localhost:4109/healthz
```

`schemaMigration` is the latest id in `render.schema_migrations`, `none` with no database configured,
`unavailable` when the query fails.

## TODO

- Outbox relay: cross-tenant read of `render.outbox` is not solved here. See `docs/build/questions.md`
  (Chat 1, outbox relay): option A, a separate relay role with BYPASSRLS limited to the outbox tables.
- Tenant context in Python: set `app.tenant_id` and `app.org_id` with `set_config(..., true)` inside a transaction, as `withTenant` does in `@pd/service-kit`.
- Real routes: add them to the OpenAPI file first, then `routes.py` and `routes.json`.
