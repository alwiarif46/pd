"""Routes of portal in the OpenAPI file (packages/contracts/openapi/portal.yaml).

`routes.json` beside pyproject.toml must equal ROUTES. A test checks it, and `pnpm contracts:check`
compares it with the OpenAPI paths. Add a route to the contract first.
"""

ROUTES: list[dict[str, str]] = [{"method": "GET", "path": "/healthz"}]
