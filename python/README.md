# python/

uv workspace for the two Python services (09 s5): `render` (service 10) and `portal-agent` (service 13).
Each member is a folder here with its own `pyproject.toml`, Dockerfile, migrations and tests.
Both are skeletons with `GET /healthz`, `migrations/0001_init.sql`, `routes.json` (mirrors the OpenAPI paths, checked by `pnpm contracts:check`) and tests. Run `uv sync --all-packages --frozen` once (the workspace root is not a package, so a bare `uv run` does not install the members), then `uv run render`, `uv run portal-agent`, `uv run pytest`. One lock file (`uv.lock`) sits at the repo root.
