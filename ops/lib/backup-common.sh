# shellcheck shell=bash
# ops/lib/backup-common.sh - shared by infra/scripts/backup.sh, infra/scripts/restore.sh and
# ops/backup/offsite-sync.sh (sourced after infra/lib/ops-common.sh, never executed).
#
# Everything the scripts touch is overridable by environment variable, for the offline tests only:
#   PD_ETC (/etc/pd)  PD_BACKUP_MOUNT (/mnt/pdbackup)  PD_DATA_MOUNT (/mnt/pddata)  PD_LOG_DIR (/var/log/pd)
#   PD_PROJECT_DIR ([backup] project_dir)  PD_SKIP_OWNER_CHECK=1 (tests are not root)
#   PD_SKIP_MODE_CHECK=1 (tests on a file system without POSIX modes, e.g. Git Bash on Windows)
#
# Backup design (docs/plans/01-infrastructure.md s4, Drive PR #3 ops/backup):
#   pg_dump -Fc (custom format) -> borg create (encrypted repokey-blake2) on the LUKS backup volume
#   -> rclone crypt copy to Backblaze B2. The Borg passphrase is read by borg itself through
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
  [[ "$mode" == 400 || "${PD_SKIP_MODE_CHECK:-0}" == 1 ]] || bk_guard "$PD_BORG_PASS has mode $mode, must be 0400"
  [[ "${PD_SKIP_OWNER_CHECK:-0}" == 1 || "$owner" == root ]] || bk_guard "$PD_BORG_PASS is owned by $owner, must be root"
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
