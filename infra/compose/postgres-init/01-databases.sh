#!/bin/sh
# Runs once, when the Postgres data volume is empty (docker-entrypoint-initdb.d). It is not idempotent: a second run
# fails on "create role". To run it again, remove the data volume (docker compose down -v).
# - the pgvector extension in the e2e database (evidence service)
# - the Zitadel database and its login role, and no other role may connect to that database
# The 14 service roles and their schemas are made by `pnpm migrate`, not here (infra/db/README.md).
# The passwords come from the container environment. Nothing secret is written to a file.
set -eu

: "${POSTGRES_USER:?}" "${POSTGRES_DB:?}" "${ZITADEL_DB_USER:?}" "${ZITADEL_DB_NAME:?}" "${ZITADEL_DB_PASSWORD:?}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v zuser="$ZITADEL_DB_USER" -v zdb="$ZITADEL_DB_NAME" -v zpass="$ZITADEL_DB_PASSWORD" <<'SQL'
create extension if not exists vector;

create role :"zuser" login password :'zpass' nosuperuser nobypassrls nocreatedb nocreaterole;
create database :"zdb" owner :"zuser";
-- Same treatment as the e2e database (infra/db/README.md): PUBLIC may not connect, only the Zitadel role may.
revoke connect on database :"zdb" from public;
grant connect on database :"zdb" to :"zuser";
SQL
