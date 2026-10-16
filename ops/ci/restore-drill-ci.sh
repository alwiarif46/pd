#!/usr/bin/env bash
# ops/ci/restore-drill-ci.sh - the restore drill against REAL Postgres, in CI (.github/workflows/ci.yml, job
# restore-drill). It closes the gap the offline tests leave: ops/tests runs restore.sh against fakes, so nothing there
# proves that a real pg_dump of the migrated schema restores through restore.sh's SQL path.
#
#   1. a real `pg_dump -Fc` of the SOURCE database (migrated with the repo's migrations, plus a seeded organization)
#   2. the validation restore.sh runs before it touches anything (pg_restore --file=/dev/null), on the dump AND on a
#      truncated copy of it, which must be refused
#   3. restore.sh's SQL path into the TARGET Postgres, from ops/lib/backup-common.sh (the same variables restore.sh
#      uses): BK_RECREATE_SQL (DROP ... WITH (FORCE), CREATE DATABASE pd OWNER pd_owner), BK_ROLES_SQL (pd_app and
#      pd_system with migration 0001's attributes), pg_restore "${BK_PG_RESTORE_ARGS[@]}" (--exit-on-error
#      --single-transaction). It runs twice: into a fresh cluster, and again over the restored database.
#   4. checks: drizzle.__drizzle_migrations count = packages/core/src/db/migrations/meta/_journal.json entries; the
#      row count of every table and the number of row-level-security policies match the source; pd_app and pd_system
#      have exactly the attributes the migrations gave them in the SOURCE (login, superuser, bypassrls, createdb,
#      createrole, inherit, replication), read with the same query on both sides.
# Borg is not part of this (the archive layer is tested with the fake borg in ops/tests). No network beyond the two CI
# service containers: every command is `docker exec` into them.
#
# Usage: ops/ci/restore-drill-ci.sh --src CONTAINER --dst CONTAINER --workdir DIR [--seed]
#   CONTAINER  docker container ids of the source and target Postgres (job.services.<name>.id); both run with
#              POSTGRES_USER=pd_owner and POSTGRES_DB=pd, like the compose postgres service
#   --workdir  an existing directory for the dump (CI: $RUNNER_TEMP); only pd.dump and pd-truncated.dump are written
#              there, and only those two files are removed again
#   --seed     insert one organization into the source first (so a row really travels through the dump)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
# shellcheck source=../../infra/lib/ops-common.sh
source "$REPO/infra/lib/ops-common.sh"
# shellcheck source=../lib/backup-common.sh
source "$REPO/ops/lib/backup-common.sh"
OPS_NAME=restore-drill-ci

SRC="" DST="" WORK="" SEED=0
while (( $# )); do
  case "$1" in
    --src) SRC="${2:?--src needs a container}"; shift ;;
    --dst) DST="${2:?--dst needs a container}"; shift ;;
    --workdir) WORK="${2:?--workdir needs a directory}"; shift ;;
    --seed) SEED=1 ;;
    -h | --help) ops_usage "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done
[[ "$SRC" =~ ^[A-Za-z0-9_.-]{1,128}$ && "$DST" =~ ^[A-Za-z0-9_.-]{1,128}$ ]] || die "--src and --dst must be container ids"
[[ "$SRC" != "$DST" ]] || die "--src and --dst must be different containers"
[[ -n "$WORK" && -d "$WORK" ]] || die "--workdir must be an existing directory"
DUMP="$WORK/pd.dump" TRUNC="$WORK/pd-truncated.dump"
cleanup() { rm -f -- "$DUMP" "$TRUNC"; }
trap cleanup EXIT

psql_in() { local c="$1" db="$2"; shift 2; docker exec -i "$c" psql -U pd_owner -d "$db" -v ON_ERROR_STOP=1 -X -q "$@"; }
# counts C: one line per table (schema.table rows) plus the policy count, in a stable order
counts() {
  local t
  for t in $(psql_in "$1" pd -Atc "SELECT format('%I.%I', schemaname, tablename) FROM pg_tables WHERE schemaname IN ('public','drizzle') ORDER BY 1"); do
    printf '%s %s\n' "$t" "$(psql_in "$1" pd -Atc "SELECT count(*) FROM $t")"
  done
  printf 'policies %s\n' "$(psql_in "$1" pd -Atc "SELECT count(*) FROM pg_policies")"
}

echo "== 0. Source"
if (( SEED )); then
  psql_in "$SRC" pd -c "INSERT INTO organizations (name, plan, plan_status) VALUES ('PD restore drill', 'free', 'free')"
fi
JOURNAL_N="$(grep -c '"tag"' "$REPO/packages/core/src/db/migrations/meta/_journal.json")"
SRC_MIG="$(psql_in "$SRC" pd -Atc 'SELECT count(*) FROM drizzle.__drizzle_migrations')"
[[ "$SRC_MIG" == "$JOURNAL_N" ]] || die "the source is not fully migrated ($SRC_MIG of $JOURNAL_N migrations)"
SRC_ORGS="$(psql_in "$SRC" pd -Atc 'SELECT count(*) FROM organizations')"
(( SRC_ORGS > 0 )) || die "the source holds no organization: nothing would prove that rows travel (use --seed)"
SRC_COUNTS="$(counts "$SRC")"
# roles C: the attributes of pd_app and pd_system, one stable string (the same query on both sides, so the boolean
# text form does not matter)
roles() {
  psql_in "$1" postgres -Atc "SELECT string_agg(format('%s:login=%s,super=%s,bypassrls=%s,createdb=%s,createrole=%s,inherit=%s,replication=%s', rolname, rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolinherit, rolreplication), ' ' ORDER BY rolname) FROM pg_roles WHERE rolname IN ('pd_app','pd_system')"
}
SRC_ROLES="$(roles "$SRC")"
[[ "$SRC_ROLES" == pd_app:*" pd_system:"* ]] || die "the source lacks pd_app or pd_system (migration 0001 creates both): '$SRC_ROLES'"
echo "source: $SRC_MIG migrations, $SRC_ORGS organization(s), $(grep -c . <<<"$SRC_COUNTS") tables+policies line(s)"

echo "== 1. pg_dump -Fc"
docker exec "$SRC" pg_dump -U pd_owner -d pd -Fc >"$DUMP"
SIZE="$(wc -c <"$DUMP" | tr -d ' ')"
[[ "$(head -c 5 "$DUMP")" == PGDMP ]] || die "the dump does not start with PGDMP"
echo "dump: $SIZE bytes"

echo "== 2. Validation (restore.sh step 0: pg_restore --file=/dev/null)"
docker exec -i "$DST" pg_restore --file=/dev/null <"$DUMP" || die "a good dump failed the validation"
head -c $((SIZE / 2)) "$DUMP" >"$TRUNC"
if docker exec -i "$DST" pg_restore --file=/dev/null <"$TRUNC" 2>/dev/null; then die "a truncated dump PASSED the validation"; fi
: >"$TRUNC"
if docker exec -i "$DST" pg_restore --file=/dev/null <"$TRUNC" 2>/dev/null; then die "an empty dump PASSED the validation"; fi
echo "good dump accepted; truncated and empty dumps refused"

for round in 1 2; do
  echo "== 3.$round Restore into the target (restore.sh steps 3-5, from ops/lib/backup-common.sh)"
  psql_in "$DST" postgres -c "${BK_RECREATE_SQL[0]}" -c "${BK_RECREATE_SQL[1]}"
  psql_in "$DST" postgres -c "$BK_ROLES_SQL"
  docker exec -i "$DST" pg_restore "${BK_PG_RESTORE_ARGS[@]}" <"$DUMP"

  echo "== 4.$round Verify"
  DST_MIG="$(psql_in "$DST" pd -Atc 'SELECT count(*) FROM drizzle.__drizzle_migrations')"
  [[ "$DST_MIG" == "$JOURNAL_N" ]] || die "round $round: $DST_MIG migrations restored, journal has $JOURNAL_N"
  DST_COUNTS="$(counts "$DST")"
  if [[ "$DST_COUNTS" != "$SRC_COUNTS" ]]; then
    diff <(printf '%s\n' "$SRC_COUNTS") <(printf '%s\n' "$DST_COUNTS") || true
    die "round $round: table row counts or policies differ between source and target"
  fi
  DST_ROLES="$(roles "$DST")"
  [[ "$DST_ROLES" == "$SRC_ROLES" ]] || die "round $round: restored roles differ from the source: source '$SRC_ROLES', target '$DST_ROLES'"
  echo "round $round: $DST_MIG migrations, identical row counts, policies and roles ($DST_ROLES)"
done
echo "RESTORE DRILL (CI): PASS"
