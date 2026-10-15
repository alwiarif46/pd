#!/usr/bin/env bash
# infra/scripts/restore.sh - restore the database from a Borg archive (runs ON THE SERVER, as root).
# Implements: docs/plans/01-infrastructure.md s4. Replaces the old script, which replayed plain SQL into the live
# database (errors or a partial, duplicated restore) through a decompressed copy in /tmp.
#
# Steps, in this order:
#   1. the same mount and passphrase checks as backup.sh
#   2. a safety backup of the CURRENT database (backup.sh --no-offsite --tag pre-restore), unless --no-safety-backup
#   3. stop the api and worker containers
#   4. drop and recreate the database: DROP DATABASE IF EXISTS pd WITH (FORCE); CREATE DATABASE pd OWNER pd_owner
#   5. create the roles pd_app and pd_system when missing, with the exact attributes of migration 0001
#      (pg_restore does not carry roles; the migration would create them on the next deploy, but the dump needs them now)
#   6. borg extract --stdout ::ARCHIVE pd.dump | pg_restore --exit-on-error --single-transaction
#      (the dump streams straight from Borg into pg_restore: no decompressed copy is written anywhere)
#   7. start the api and worker again
# After it: set the pd_app password again (roles' passwords are not in the dump): docs/plans/01-infrastructure.md s6.
#
# Usage: sudo infra/scripts/restore.sh --list
#        sudo infra/scripts/restore.sh --archive NAME|latest --confirm [--no-safety-backup] [--dry-run] [--tenant PATH]
# Without --confirm it refuses. On a terminal it also asks you to type the archive name.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/ops-common.sh
source "$SCRIPT_DIR/../lib/ops-common.sh"
# shellcheck source=../../ops/lib/backup-common.sh
source "$SCRIPT_DIR/../../ops/lib/backup-common.sh"
usage() { ops_usage "${BASH_SOURCE[0]}"; }

ops_init restore "$@"
LIST=0 ARCHIVE="" CONFIRM=0 SAFETY=1
set -- ${OPS_ARGS[@]+"${OPS_ARGS[@]}"}
while (( $# )); do
  case "$1" in
    --list) LIST=1 ;;
    --archive) ARCHIVE="${2:?--archive needs a name or 'latest'}"; shift ;;
    --confirm) CONFIRM=1 ;;
    --no-safety-backup) SAFETY=0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done
require_root
bk_compose_init
bk_check_mount
bk_check_pass
bk_borg_env

if (( LIST )); then
  run borg list --short
  exit 0
fi
[[ -n "$ARCHIVE" ]] || { usage; die "give --archive NAME|latest (see --list)"; }
[[ "$ARCHIVE" =~ ^[A-Za-z0-9._:-]{1,100}$ ]] || die "archive name has unexpected characters: $ARCHIVE"

if [[ "$ARCHIVE" == latest ]]; then
  if is_dry; then
    ARCHIVE="<newest archive>"
  else
    ARCHIVE="$(borg list --short | sort | tail -1)"
    [[ -n "$ARCHIVE" ]] || die "the Borg repository holds no archive"
    log "latest archive: $ARCHIVE"
  fi
fi

if (( ! CONFIRM )) && ! is_dry; then
  die "this replaces the live database with archive $ARCHIVE. Re-run with --confirm (preview with --dry-run)"
fi
if (( CONFIRM )) && ! is_dry && [[ -t 0 ]]; then
  read -r -p "Type the archive name ($ARCHIVE) to replace the live database: " typed
  [[ "$typed" == "$ARCHIVE" ]] || die "name does not match; nothing changed"
fi

PSQL=("${COMPOSE[@]}" exec -T postgres psql -U pd_owner -d postgres -v ON_ERROR_STOP=1)

echo "== 1. Safety backup of the current database"
if (( SAFETY )); then
  BACKUP_ARGS=(--no-offsite --tag pre-restore)
  [[ -n "${PD_TENANT:-}" ]] && BACKUP_ARGS+=(--tenant "$PD_TENANT")
  is_dry && BACKUP_ARGS+=(--dry-run)
  run bash "$SCRIPT_DIR/backup.sh" "${BACKUP_ARGS[@]}"
else
  echo "skipped (--no-safety-backup)"
fi

echo "== 2. Stop api and worker"
run "${COMPOSE[@]}" stop api worker

echo "== 3. Recreate the database"
run "${PSQL[@]}" -c 'DROP DATABASE IF EXISTS pd WITH (FORCE)' -c 'CREATE DATABASE pd OWNER pd_owner'

echo "== 4. Roles (exact attributes of migration 0001)"
ROLES_SQL="DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pd_app') THEN
    CREATE ROLE pd_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pd_system') THEN
    CREATE ROLE pd_system NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END \$\$;"
run "${PSQL[@]}" -c "$ROLES_SQL"

echo "== 5. Restore archive $ARCHIVE"
if is_dry; then
  echo "[dry-run] borg extract --stdout ::$ARCHIVE pd.dump | ${COMPOSE[*]} exec -T postgres pg_restore -U pd_owner -d pd --exit-on-error --single-transaction"
else
  borg extract --stdout "::$ARCHIVE" pd.dump \
    | "${COMPOSE[@]}" exec -T postgres pg_restore -U pd_owner -d pd --exit-on-error --single-transaction
fi

echo "== 6. Start api and worker"
run "${COMPOSE[@]}" start api worker

echo
echo "Restore of $ARCHIVE done. Now set the pd_app password again (it is not part of the dump): docs/plans/01-infrastructure.md s6."
echo "STATE.md: | $(date +%F) | 01 | restore | done | database restored from Borg archive $ARCHIVE on $(tenant_get tenant.hostname) |"
