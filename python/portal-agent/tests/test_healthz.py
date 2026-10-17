import json
import os
import uuid
from pathlib import Path

import psycopg
import pytest
from fastapi.testclient import TestClient

from portal_agent.app import create_app, schema_migration
from portal_agent.main import DEFAULT_PORT
from portal_agent.routes import ROUTES

ROOT = Path(__file__).resolve().parents[1]
TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL")


def test_healthz_without_database(monkeypatch):
    monkeypatch.delenv("PORTAL_DATABASE_URL", raising=False)
    client = TestClient(create_app())
    res = client.get("/healthz")
    assert res.status_code == 200
    assert res.json() == {"service": "portal", "version": "0.1.0", "schemaMigration": "none"}


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
    assert DEFAULT_PORT == 4112


def test_init_migration_has_outbox_and_rls():
    sql = (ROOT / "migrations" / "0001_init.sql").read_text()
    assert "create schema if not exists portal;" in sql
    assert "portal.outbox force row level security" in sql


@pytest.mark.skipif(not TEST_DATABASE_URL, reason="TEST_DATABASE_URL is not set")
def test_healthz_with_database():
    base = psycopg.conninfo.conninfo_to_dict(TEST_DATABASE_URL)
    name = "py_portal_" + uuid.uuid4().hex[:8]
    with psycopg.connect(TEST_DATABASE_URL, autocommit=True) as admin:
        admin.execute(f'create database "{name}"')
    try:
        url = psycopg.conninfo.make_conninfo(TEST_DATABASE_URL, dbname=name)
        with psycopg.connect(url, autocommit=True) as conn:
            conn.execute((ROOT / "migrations" / "0001_init.sql").read_text())
            conn.execute("insert into portal.schema_migrations (id) values ('0001_init.sql')")
        res = TestClient(create_app(url)).get("/healthz")
        assert res.json() == {"service": "portal", "version": "0.1.0", "schemaMigration": "0001_init.sql"}
    finally:
        with psycopg.connect(TEST_DATABASE_URL, autocommit=True) as admin:
            admin.execute(f'drop database "{name}" with (force)')
    assert base is not None
