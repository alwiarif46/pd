"""Routes of render in the OpenAPI file (packages/contracts/openapi/render.yaml).

`routes.json` beside pyproject.toml must equal ROUTES. A test checks it, and `pnpm contracts:check`
compares it with the OpenAPI paths. Add a route to the contract first.

Handlers arrive PR by PR in chat 4 (progress file). Until a handler exists, the route is contract only.
"""

ROUTES: list[dict[str, str]] = [
    {"method": "GET", "path": "/healthz"},
    {"method": "GET", "path": "/tools"},
    {"method": "POST", "path": "/tools/{name}"},
    {"method": "POST", "path": "/render"},
    {"method": "GET", "path": "/render/{renderId}"},
    {"method": "POST", "path": "/packages"},
    {"method": "GET", "path": "/packages/{packageId}"},
    {"method": "GET", "path": "/packages/{packageId}/download"},
    {"method": "GET", "path": "/format-specs"},
    {"method": "GET", "path": "/format-specs/{specId}"},
    {"method": "GET", "path": "/fonts"},
    {"method": "GET", "path": "/fonts/requests"},
    {"method": "POST", "path": "/fonts/requests"},
]
