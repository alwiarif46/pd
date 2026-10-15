#!/usr/bin/env bash
# ops/restore-drill/drill.sh - a provider-neutral restore drill in a scratch Postgres container.
# Implements: docs/plans/01-infrastructure.md s4 ("restore test"). Drive's drill buys a short-lived OVH VM; PD's runs
# on ANY host that has docker, borg and rclone (your laptop, the server, a CI runner), so it is the same drill whichever
# provider hosts production (open question Q-14). It proves two things: the backup restores, and how long it takes
# against the 4 h RTO.
#
#   plan   print the steps; touches nothing (no docker call)
#   run    1. optionally pull the off-site copy: rclone copy b2crypt:borg -> a temp directory (--from-offsite)
#          2. docker run a throwaway postgres:16-alpine with --network none (no way out, no way in)
#          3. wait for pg_isready
#          4. create the roles pd_app and pd_system and the database pd, then
#             borg extract --stdout (newest archive) | pg_restore --exit-on-error --single-transaction
#          5. verify: the row count of drizzle.__drizzle_migrations equals the number of entries in
#             packages/core/src/db/migrations/meta/_journal.json; print the organizations count (warns when 0)
#          6. time the whole run against the 4 h RTO
#          7. always: docker rm -f the container (EXIT trap) and shred the temp files
#          8. print a STATE.md line
#
# Usage: ops/restore-drill/drill.sh plan|run [--repo PATH | --from-offsite --rclone-env FILE] [--borg-pass FILE]
#                                    [--dry-run] [--tenant PATH]
#   --repo PATH        a Borg repository directory (default: /mnt/pdbackup/borg; ignored with --from-offsite)
#   --from-offsite     pull b2crypt:borg first; needs --rclone-env FILE with the READ-ONLY restore key
#                      (RCLONE_CONFIG_B2_ACCOUNT, _B2_KEY, _B2CRYPT_PASSWORD, _B2CRYPT_PASSWORD2)
#   --borg-pass FILE   the Borg passphrase file (default /etc/pd/borg.pass); read through BORG_PASSCOMMAND only
# Needs docker, borg (and rclone for --from-offsite). The restore key never has write access to B2.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../infra/lib/ops-common.sh
source "$HERE/../../infra/lib/ops-common.sh"
# shellcheck source=../lib/backup-common.sh
source "$HERE/../lib/backup-common.sh"
usage() { ops_usage "${BASH_SOURCE[0]}"; }

ops_init drill "$@"
MODE="" REPO="" FROM_OFFSITE=0 RCLONE_ENV_FILE="" BORG_PASS_FILE="$PD_BORG_PASS"
set -- ${OPS_ARGS[@]+"${OPS_ARGS[@]}"}
while (( $# )); do
  case "$1" in
    plan | run) [[ -z "$MODE" ]] || die "one mode at a time"; MODE="$1" ;;
    --repo) REPO="${2:?--repo needs a path}"; shift ;;
    --from-offsite) FROM_OFFSITE=1 ;;
    --rclone-env) RCLONE_ENV_FILE="${2:?--rclone-env needs a file}"; shift ;;
    --borg-pass) BORG_PASS_FILE="${2:?--borg-pass needs a file}"; shift ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done
[[ -n "$MODE" ]] || { usage; die "mode required: plan | run"; }
(( FROM_OFFSITE )) && [[ -z "$RCLONE_ENV_FILE" ]] && die "--from-offsite needs --rclone-env FILE (the read-only restore key)"
[[ -z "$REPO" ]] && REPO="$PD_BORG_REPO"
RTO_SECONDS=14400
REPO_ROOT_DIR="$(cd "$HERE/../.." && pwd)"
JOURNAL="$REPO_ROOT_DIR/packages/core/src/db/migrations/meta/_journal.json"
BUCKET="$(tget backup.bucket)"
PREFIX="$(tget backup.crypt_prefix)"
NAME="pd-drill-$(date -u +%Y%m%d%H%M%S)"

if [[ "$MODE" == plan ]] || is_dry; then
  cat <<PLAN
Restore drill (provider-neutral; docs/plans/01-infrastructure.md s4)
  source      : $( (( FROM_OFFSITE )) && echo "B2 copy b2crypt:borg ($BUCKET/$PREFIX) pulled to a temp directory with the read-only key in $RCLONE_ENV_FILE" || echo "Borg repository $REPO")
  container   : docker run -d --rm --name $NAME --network none postgres:16-alpine   (random password, passed through the environment)
  restore     : roles pd_app / pd_system, database pd, borg extract --stdout (newest archive) | pg_restore --exit-on-error --single-transaction
  verify      : drizzle.__drizzle_migrations row count == entries in packages/core/src/db/migrations/meta/_journal.json; organizations count
  limit       : the whole run must finish inside the 4 h RTO ($RTO_SECONDS s)
  cleanup     : docker rm -f $NAME and shred the temp files, even when a step fails
[plan only: no docker, borg or rclone command was run]
PLAN
  exit 0
fi

require_cmd docker borg
(( FROM_OFFSITE )) && require_cmd rclone
[[ -f "$BORG_PASS_FILE" ]] || die "missing Borg passphrase file: $BORG_PASS_FILE (--borg-pass FILE)"
pd_find_python
JOURNAL_N="$("$PD_PY" -c 'import json,sys; print(len(json.load(open(sys.argv[1], encoding="utf-8"))["entries"]))' "$(pd_native_path "$JOURNAL")")" \
  || die "cannot read $JOURNAL"

TMPD="$(mktemp -d)"
CONTAINER=""
cleanup() {
  local rc=$?
  if [[ -n "$CONTAINER" ]]; then docker rm -f "$NAME" >/dev/null 2>&1 || true; fi
  if [[ -d "$TMPD" ]]; then
    if have shred; then find "$TMPD" -type f -exec shred -u {} + 2>/dev/null || true; fi
    rm -rf "$TMPD"
  fi
  return $rc
}
trap cleanup EXIT
START="$(date +%s)"

echo "== 1. Source"
if (( FROM_OFFSITE )); then
  bk_load_env_keys "$RCLONE_ENV_FILE" RCLONE_CONFIG_B2_ACCOUNT RCLONE_CONFIG_B2_KEY RCLONE_CONFIG_B2CRYPT_PASSWORD RCLONE_CONFIG_B2CRYPT_PASSWORD2 \
    || die "missing $RCLONE_ENV_FILE"
  for k in RCLONE_CONFIG_B2_ACCOUNT RCLONE_CONFIG_B2_KEY RCLONE_CONFIG_B2CRYPT_PASSWORD RCLONE_CONFIG_B2CRYPT_PASSWORD2; do
    [[ -n "${!k:-}" ]] || die "$k is empty in $RCLONE_ENV_FILE"
  done
  ops_render "$HERE/../backup/rclone.conf.template" "BUCKET=$BUCKET" "CRYPT_PREFIX=$PREFIX" >"$TMPD/rclone.conf"
  mkdir -p "$TMPD/borg"
  run rclone --config "$TMPD/rclone.conf" copy "b2crypt:borg" "$TMPD/borg" --fast-list
  REPO="$TMPD/borg"
fi
export BORG_REPO="$REPO" BORG_PASSCOMMAND="cat $BORG_PASS_FILE" BORG_RELOCATED_REPO_ACCESS_IS_OK=no
unset BORG_PASSPHRASE
ARCHIVE="$(borg list --short | sort | tail -1)"
[[ -n "$ARCHIVE" ]] || die "the repository holds no archive"
echo "newest archive: $ARCHIVE"

echo "== 2. Scratch Postgres (no network)"
DRILL_PW="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
export POSTGRES_PASSWORD="$DRILL_PW"
pd_register_secret "$DRILL_PW"
docker run -d --rm --name "$NAME" --network none -e POSTGRES_USER=pd_owner -e POSTGRES_PASSWORD postgres:16-alpine >/dev/null
CONTAINER="$NAME"
unset POSTGRES_PASSWORD

echo "== 3. Wait for pg_isready"
for i in $(seq 1 90); do
  if docker exec "$NAME" pg_isready -U pd_owner >/dev/null 2>&1; then break; fi
  (( i < 90 )) || die "Postgres did not become ready"
  sleep 1
done

echo "== 4. Roles, database, restore"
ROLES_SQL="DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pd_app') THEN
    CREATE ROLE pd_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pd_system') THEN
    CREATE ROLE pd_system NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END \$\$;"
docker exec "$NAME" psql -U pd_owner -d postgres -v ON_ERROR_STOP=1 -c "$ROLES_SQL" -c 'CREATE DATABASE pd OWNER pd_owner' >/dev/null
borg extract --stdout "::$ARCHIVE" pd.dump | docker exec -i "$NAME" pg_restore -U pd_owner -d pd --exit-on-error --single-transaction

echo "== 5. Verify"
APPLIED="$(docker exec "$NAME" psql -U pd_owner -d pd -Atc 'select count(*) from drizzle.__drizzle_migrations' | tr -d '[:space:]')"
ORGS="$(docker exec "$NAME" psql -U pd_owner -d pd -Atc 'select count(*) from organizations' | tr -d '[:space:]')"
echo "migrations applied: $APPLIED, journal entries: $JOURNAL_N"
echo "organizations     : $ORGS"
RESULT=ok
if [[ "$APPLIED" != "$JOURNAL_N" ]]; then
  warn "the restored database has $APPLIED migrations but the repository journal has $JOURNAL_N: the backup is from another schema version, or the restore is incomplete"
  RESULT=FAILED
fi
if [[ "${ORGS:-0}" == 0 ]]; then warn "organizations is empty: fine for a new install, suspicious for a live one"; fi

echo "== 6. Time"
ELAPSED=$(( $(date +%s) - START ))
echo "restore took ${ELAPSED} s (RTO ${RTO_SECONDS} s)"
if (( ELAPSED > RTO_SECONDS )); then warn "slower than the 4 h RTO"; RESULT=FAILED; fi

echo "STATE.md: | $(date +%F) | 01 | restore drill | $RESULT | archive $ARCHIVE restored in ${ELAPSED} s into a scratch container; migrations $APPLIED/$JOURNAL_N; organizations $ORGS |"
[[ "$RESULT" == ok ]]
