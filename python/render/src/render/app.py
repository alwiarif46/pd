"""FastAPI app with GET /healthz (09 s9.1)."""

from __future__ import annotations

import os
import re

import psycopg
from fastapi import FastAPI

from . import __version__

SERVICE_ID = "render"
SCHEMA = "render"
DATABASE_URL_VAR = "RENDER_DATABASE_URL"
_IDENT = re.compile(r"^[a-z_][a-z0-9_]*$")


def schema_migration(database_url: str | None, schema: str = SCHEMA) -> str:
    """Latest applied migration id: "none" with no database, "unavailable" on any failure. Never raises."""
    if not database_url:
        return "none"
    try:
        if not _IDENT.match(schema):
            return "unavailable"
        with psycopg.connect(database_url, connect_timeout=2, options="-c statement_timeout=2000") as conn:
            row = conn.execute(
                f'select id from "{schema}".schema_migrations order by id desc limit 1'
            ).fetchone()
        if not row:
            return "none"
        value = row[0]
        # A SQL_ASCII database hands text back as bytes.
        return value.decode() if isinstance(value, bytes) else str(value)
    except Exception:  # noqa: BLE001 - healthz must not fail
        return "unavailable"


def create_app(database_url: str | None = None) -> FastAPI:
    """`database_url` overrides RENDER_DATABASE_URL, which is read on each request when not given."""
    app = FastAPI(title=SERVICE_ID, version=__version__)

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        url = database_url if database_url is not None else os.environ.get(DATABASE_URL_VAR)
        return {
            "service": SERVICE_ID,
            "version": __version__,
            "schemaMigration": schema_migration(url),
        }

    return app


app = create_app()
