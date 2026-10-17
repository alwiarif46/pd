import json
import os
import uuid
from contextlib import contextmanager
from pathlib import Path

import psycopg
import pytest
from fastapi.testclient import TestClient

from render.app import create_app, schema_migration
from render.main import DEFAULT_PORT
from render.routes import ROUTES

ROOT = Path(__file__).resolve().parents[1]
TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL")


def test_healthz_without_database(monkeypatch):
    monkeypatch.delenv("RENDER_DATABASE_URL", raising=False)
    client = TestClient(create_app())
    res = client.get("/healthz")
    assert res.status_code == 200
    assert res.json() == {"service": "render", "version": "0.1.0", "schemaMigration": "none"}


def test_healthz_unavailable_when_database_is_down():
    client = TestClient(create_app("postgres://nobody@127.0.0.1:1/none"))
    res = client.get("/healthz")
    assert res.status_code == 200
    assert res.json()["schemaMigration"] == "unavailable"


def test_unsafe_schema_name_is_unavailable():
    assert schema_migration("postgres://x@127.0.0.1:1/none", 'a"; drop table t; --') == "unavailable"


def test_routes_json_matches_routes_py():
    assert json.loads((ROOT / "routes.json").read_text()) == ROUTES


def test_default_port():
    assert DEFAULT_PORT == 4109


def test_init_migration_has_outbox_and_rls():
    sql = (ROOT / "migrations" / "0001_init.sql").read_text()
    assert "create schema if not exists render;" in sql
    assert "render.outbox force row level security" in sql


# Roles are cluster-wide and the TypeScript tests hold this advisory lock while they reset them.
CLUSTER_LOCK = 7_450_902
ROLE = "render_svc"

CREATE_ROLE_IF_MISSING = (
    "do $$ begin create role {role} nologin; "
    "exception when duplicate_object then null; end $$"
)


def ensure_role(conn, role: str = ROLE) -> None:
    """0001_init.sql grants to render_svc, which only the TypeScript migrator creates. Create it if missing."""
    assert role.replace("_", "").isalnum() and role == role.lower()
    conn.execute(CREATE_ROLE_IF_MISSING.format(role=f'"{role}"'))


def role_exists(conn, role: str) -> bool:
    return conn.execute("select 1 from pg_roles where rolname = %s", (role,)).fetchone() is not None


@contextmanager
def scratch_database(prefix: str):
    name = f"{prefix}_" + uuid.uuid4().hex[:8]
    with psycopg.connect(TEST_DATABASE_URL, autocommit=True) as admin:
        admin.execute(f'create database "{name}"')
    try:
        yield name, psycopg.conninfo.make_conninfo(TEST_DATABASE_URL, dbname=name)
    finally:
        with psycopg.connect(TEST_DATABASE_URL, autocommit=True) as admin:
            admin.execute(f'drop database "{name}" with (force)')


@pytest.fixture
def cluster_lock():
    with psycopg.connect(TEST_DATABASE_URL, autocommit=True) as lock:
        lock.execute("select pg_advisory_lock(%s)", (CLUSTER_LOCK,))
        yield
        lock.execute("select pg_advisory_unlock(%s)", (CLUSTER_LOCK,))


@pytest.mark.skipif(not TEST_DATABASE_URL, reason="TEST_DATABASE_URL is not set")
def test_healthz_with_database(cluster_lock):
    with scratch_database("py_render") as (_, url):
        with psycopg.connect(TEST_DATABASE_URL, autocommit=True) as admin:
            ensure_role(admin)
        with psycopg.connect(url, autocommit=True) as conn:
            conn.execute((ROOT / "migrations" / "0001_init.sql").read_text())
            conn.execute("insert into render.schema_migrations (id) values ('0001_init.sql')")
        res = TestClient(create_app(url)).get("/healthz")
        assert res.json() == {"service": "render", "version": "0.1.0", "schemaMigration": "0001_init.sql"}


@pytest.mark.skipif(not TEST_DATABASE_URL, reason="TEST_DATABASE_URL is not set")
def test_ensure_role_creates_a_missing_role_and_is_idempotent(cluster_lock):
    """The missing-role path, on a scratch role name (the real render_svc is not dropped)."""
    scratch = ROLE + "_t" + uuid.uuid4().hex[:6]
    sql = (ROOT / "migrations" / "0001_init.sql").read_text().replace(ROLE, scratch)
    assert scratch in sql
    with psycopg.connect(TEST_DATABASE_URL, autocommit=True) as admin:
        try:
            assert not role_exists(admin, scratch)
            with scratch_database("py_render_r") as (_, url):
                with psycopg.connect(url, autocommit=True) as conn:
                    with pytest.raises(psycopg.errors.UndefinedObject):
                        conn.execute(sql)  # the GRANT fails without the role
                ensure_role(admin, scratch)
                ensure_role(admin, scratch)  # already there: no error
                assert role_exists(admin, scratch)
                with psycopg.connect(url, autocommit=True) as conn:
                    conn.execute(sql)
        finally:
            admin.execute(f'drop role if exists "{scratch}"')


def test_connection_has_a_statement_timeout(monkeypatch):
    import render.app as app_module

    seen = {}

    def fake_connect(url, **kwargs):
        seen.update(kwargs)
        raise psycopg.OperationalError("stop here")

    monkeypatch.setattr(app_module.psycopg, "connect", fake_connect)
    assert app_module.schema_migration("postgres://x@127.0.0.1:1/none") == "unavailable"
    assert seen == {"connect_timeout": 2, "options": "-c statement_timeout=2000"}
