# shellcheck shell=bash
# ops/lib/backup-common.sh - shared by infra/scripts/backup.sh, infra/scripts/restore.sh and
# ops/backup/offsite-sync.sh (sourced after infra/lib/ops-common.sh, never executed).
#
# Everything the scripts touch is overridable by environment variable, for the offline tests only:
#   PD_ETC (/etc/pd)  PD_BACKUP_MOUNT (/mnt/pdbackup)  PD_DATA_MOUNT (/mnt/pddata)  PD_LOG_DIR (/var/log/pd)
#   PD_PROJECT_DIR ([backup] project_dir)  PD_SKIP_OWNER_CHECK=1 (tests are not root)
#   PD_SKIP_MODE_CHECK=1 (tests on a file system without POSIX modes, e.g. Git Bash on Windows)
# The two PD_SKIP_* switches are IGNORED when the process really runs as root (bash's $EUID, which a fake `id` on
# PATH cannot change): on the server, under sudo, the owner and mode of borg.pass are always checked.
#
# Backup design (docs/plans/01-infrastructure.md s4, Drive PR #3 ops/backup):
#   borg create --content-from-command -- pg_dump -Fc (custom format; encrypted repokey-blake2) on the LUKS backup
#   volume, checked with bk_validate_archive, -> rclone crypt copy to Backblaze B2. The Borg passphrase is read by borg itself through
#   BORG_PASSCOMMAND from /etc/pd/borg.pass (root, 0400); it is never in argv or in the environment.

PD_ETC="${PD_ETC:-/etc/pd}"
PD_BACKUP_MOUNT="${PD_BACKUP_MOUNT:-/mnt/pdbackup}"
PD_DATA_MOUNT="${PD_DATA_MOUNT:-/mnt/pddata}"
PD_LOG_DIR="${PD_LOG_DIR:-/var/log/pd}"
PD_BACKUP_MAPPER="/dev/mapper/pdbackup"
PD_BORG_REPO="$PD_BACKUP_MOUNT/borg"
PD_BORG_PASS="$PD_ETC/borg.pass"
PD_BORG_KEY_EXPORT="$PD_ETC/borg-key.txt"

# bk_guard MSG: a failed safety check stops a real run; under --dry-run it is only reported.
bk_guard() {
  if is_dry; then warn "would refuse: $*"; else die "$*"; fi
}

# bk_compose_init: sets PROJECT_DIR and the COMPOSE array (the compose file and env file are passed explicitly, so
# the script works from any directory: the old scripts ran `docker compose` with neither and failed).
bk_compose_init() {
  PROJECT_DIR="${PD_PROJECT_DIR:-$(tenant_get backup.project_dir /opt/pd)}"
  COMPOSE=(docker compose --env-file "$PROJECT_DIR/.env" -f "$PROJECT_DIR/infra/docker-compose.yml")
}

# bk_check_mount: /mnt/pdbackup must be mounted from the LUKS mapper, otherwise the Borg repository would be
# created on the unencrypted root disk.
bk_check_mount() {
  local src
  src="$(findmnt -no SOURCE "$PD_BACKUP_MOUNT" 2>/dev/null || true)"
  if [[ "$src" != "$PD_BACKUP_MAPPER" ]]; then
    bk_guard "$PD_BACKUP_MOUNT is not mounted from $PD_BACKUP_MAPPER (found: '${src:-not mounted}'): refusing to write the backup to the root disk"
  fi
}

# bk_check_pass: /etc/pd/borg.pass must exist, be mode 0400 and (unless tests) owned by root.
bk_check_pass() {
  local mode owner
  if [[ ! -f "$PD_BORG_PASS" ]]; then
    bk_guard "missing $PD_BORG_PASS (root, 0400): create the Borg passphrase first (infra/scripts/backup.sh --init; HUMAN-TODO H-04)"
    return 0
  fi
  mode="$(stat -c %a "$PD_BORG_PASS")"
  owner="$(stat -c %U "$PD_BORG_PASS")"
  [[ "$mode" == 400 ]] || bk_test_skip PD_SKIP_MODE_CHECK || bk_guard "$PD_BORG_PASS has mode $mode, must be 0400"
  [[ "$owner" == root ]] || bk_test_skip PD_SKIP_OWNER_CHECK || bk_guard "$PD_BORG_PASS is owned by $owner, must be root"
}

# bk_real_uid: the effective uid of this bash process. $EUID is set by bash itself, so the fake `id` the tests put on
# PATH (it answers 0 so that require_root passes) cannot make a real root run look unprivileged.
bk_real_uid() { printf '%s' "$EUID"; }

# bk_test_skip VAR: true when the test switch VAR is 1 AND the process is not really root. Under sudo it is always false.
bk_test_skip() {
  [[ "${!1:-0}" == 1 ]] || return 1
  if [[ "$(bk_real_uid)" == 0 ]]; then
    warn "$1=1 is ignored: running as root (test switches only work for an unprivileged test run)"
    return 1
  fi
  return 0
}

# bk_borg_env: the environment borg needs. No passphrase value in the environment, only the command that prints it.
bk_borg_env() {
  export BORG_REPO="$PD_BORG_REPO"
  export BORG_PASSCOMMAND="cat $PD_BORG_PASS"
  export BORG_RELOCATED_REPO_ACCESS_IS_OK=no
  export BORG_UNKNOWN_UNENCRYPTED_REPO_ACCESS_IS_OK=no
  unset BORG_PASSPHRASE BORG_NEW_PASSPHRASE
}

# bk_load_env_keys FILE KEY...: read KEY=VALUE lines of FILE (never sourced) into the environment, exporting only the
# named keys. Values are never printed. Returns 1 when the file is missing.
bk_load_env_keys() {
  local f="$1" line key val k want
  shift
  [[ -f "$f" ]] || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*# || "$line" != *=* ]] && continue
    key="${line%%=*}"; val="${line#*=}"
    for k in "$@"; do
      want="$k"
      if [[ "$key" == "$want" ]]; then export "$key=$val"; pd_register_secret "$val"; fi
    done
  done <"$f"
  return 0
}

# ------------------------------------------------------------------ archives
# Archive names: pd-<UTC %Y-%m-%dT%H:%M:%S>[-TAG]. Only an untagged one is a regular hourly backup; restore.sh and the
# drill take "latest" from those alone, so a pre-restore safety copy (or a .checkpoint borg leaves after an abort) is
# never picked by accident.
BK_ARCHIVE_RE='^pd-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}$'

# bk_new_archive_name [TAG]: the name for a backup taken now.
bk_new_archive_name() { printf 'pd-%s%s' "$(date -u +%Y-%m-%dT%H:%M:%S)" "${1:+-$1}"; }

# bk_latest_archive: the newest regular archive in $BORG_REPO (empty when there is none). Fails when borg list fails.
bk_latest_archive() {
  local all
  all="$(borg list --short)" || return 1
  { grep -E "$BK_ARCHIVE_RE" <<<"$all" || true; } | sort | tail -1
}

# bk_validate_archive NAME CMD...: stream pd.dump of archive NAME through `pg_restore --file=/dev/null` run by CMD
# (e.g. docker compose ... exec -T postgres). pg_restore without a database turns the WHOLE archive into SQL and
# throws it away: it fails on an empty, truncated or non-pg_dump stream, and borg extract checks every chunk on the way.
# Nothing touches a database. (`pg_restore --list` reads only the table of contents, so a dump cut off in the data
# section would pass it.)
bk_validate_archive() {
  local name="$1"; shift
  borg extract --stdout "::$name" pd.dump | "$@" pg_restore --file=/dev/null
}

# bk_drop_archive NAME: delete archive NAME and any NAME.checkpoint* borg left behind, so a failed backup leaves
# nothing that prune could keep instead of a good archive or the off-site sync could copy.
bk_drop_archive() {
  local name="$1" all a
  all="$(borg list --short 2>/dev/null)" || { warn "borg list failed: check the repository for a partial archive $name by hand"; return 1; }
  while IFS= read -r a; do
    [[ "$a" == "$name" || "$a" == "$name".checkpoint* ]] || continue
    borg delete "::$a" || { warn "could not delete the bad archive $a: delete it by hand (borg delete ::$a)"; return 1; }
    log "deleted bad archive $a"
  done <<<"$all"
  return 0
}

# ------------------------------------------------------------------ restore SQL (restore.sh and ops/ci/restore-drill-ci.sh)
# Recreate the database, then the roles migration 0001 creates (pg_restore does not carry roles).
BK_RECREATE_SQL=('DROP DATABASE IF EXISTS pd WITH (FORCE)' 'CREATE DATABASE pd OWNER pd_owner')
BK_ROLES_SQL="DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pd_app') THEN
    CREATE ROLE pd_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pd_system') THEN
    CREATE ROLE pd_system NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END \$\$;"
BK_PG_RESTORE_ARGS=(-U pd_owner -d pd --exit-on-error --single-transaction)
