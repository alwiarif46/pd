#!/usr/bin/env bash
# infra/scripts/backup.sh - encrypted database backup (runs ON THE SERVER, as root; hourly via systemd timer).
# Implements: docs/plans/01-infrastructure.md s4 (Drive PR #3 backup design, PD runs Borg itself).
#
#   pg_dump -Fc (custom format, inside the postgres container)
#     | borg create --compression zstd --stdin-name pd.dump  ->  /mnt/pdbackup/borg  (LUKS volume, encrypted repo)
#   then borg prune (retention from [backup] borg_retention), borg compact,
#   then ops/backup/offsite-sync.sh (rclone crypt copy to Backblaze B2) unless --no-offsite.
#
# What it fixes against the old script: it passes the compose file and env file explicitly (it used to fail
# unless run next to a compose file); the dump is no longer a plain, unencrypted .sql.gz on the same disk; the
# pipeline runs under set -euo pipefail so a failed pg_dump can never leave a "good" archive.
# Refuses unless /mnt/pdbackup is mounted from /dev/mapper/pdbackup (under --dry-run it only warns) and
# /etc/pd/borg.pass is root, mode 0400. The passphrase goes to borg through BORG_PASSCOMMAND only: never in
# argv, never in the environment. Nothing is written to /tmp or /data/backups. Live files are not backed up
# (plan 01 s4): the database is.
#
# Usage: sudo infra/scripts/backup.sh [--init] [--no-offsite] [--tag NAME] [--dry-run] [--tenant PATH]
#   --init        create the Borg repository (repokey-blake2) and export its key to /etc/pd/borg-key.txt (0400)
#   --no-offsite  skip the B2 copy (restore.sh uses this for its safety backup)
#   --tag NAME    append -NAME to the archive name (restore.sh: pre-restore)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/ops-common.sh
source "$SCRIPT_DIR/../lib/ops-common.sh"
# shellcheck source=../../ops/lib/backup-common.sh
source "$SCRIPT_DIR/../../ops/lib/backup-common.sh"
usage() { ops_usage "${BASH_SOURCE[0]}"; }

ops_init backup "$@"
INIT=0 OFFSITE=1 TAG=""
set -- ${OPS_ARGS[@]+"${OPS_ARGS[@]}"}
while (( $# )); do
  case "$1" in
    --init) INIT=1 ;;
    --no-offsite) OFFSITE=0 ;;
    --tag) TAG="${2:?--tag needs a name}"; shift ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done
[[ -z "$TAG" || "$TAG" =~ ^[A-Za-z0-9._-]{1,40}$ ]] || die "--tag may only hold letters, digits, . _ -"
require_root
bk_compose_init
RETENTION="$(tenant_get backup.borg_retention "--keep-within=2d --keep-daily=30")"
read -r -a RETENTION_ARGS <<<"$RETENTION"

bk_check_mount
if (( ! INIT )); then bk_check_pass; fi
bk_borg_env

if ! is_dry; then
  mkdir -p "$PD_LOG_DIR"
  exec > >(tee -a "$PD_LOG_DIR/backup.log") 2>&1
fi
log "start $(date -u +%FT%TZ) repo=$PD_BORG_REPO"

if (( INIT )); then
  [[ -f "$PD_BORG_PASS" ]] || bk_guard "create $PD_BORG_PASS first: a long random passphrase, root, mode 0400 (umask 077; head -c 48 /dev/urandom | base64 > $PD_BORG_PASS; chmod 0400 ...), and store it in the vault (HUMAN-TODO H-04)"
  bk_check_pass
  if [[ -e "$PD_BORG_REPO/config" ]]; then
    die "$PD_BORG_REPO is already a Borg repository; --init never re-initialises one"
  fi
  run install -d -m 0700 -o root -g root "$PD_BORG_REPO"
  run borg init --encryption=repokey-blake2
  run borg key export :: "$PD_BORG_KEY_EXPORT"
  run chmod 0400 "$PD_BORG_KEY_EXPORT"
  echo "Store the key ($PD_BORG_KEY_EXPORT) and the passphrase ($PD_BORG_PASS) in the vault (HUMAN-TODO H-04), then shred /etc/pd/borg-key.txt."
  exit 0
fi

ARCHIVE="pd-{now:%Y-%m-%dT%H:%M:%S}${TAG:+-$TAG}"
if is_dry; then
  echo "[dry-run] ${COMPOSE[*]} exec -T postgres pg_dump -U pd_owner -d pd -Fc | borg create --compression zstd --stdin-name pd.dump ::$ARCHIVE -"
else
  # The pipe is the whole point: nothing is written to disk in plaintext. pipefail (set above) fails the script
  # when pg_dump fails, even though borg itself would happily store an empty stream.
  "${COMPOSE[@]}" exec -T postgres pg_dump -U pd_owner -d pd -Fc \
    | borg create --compression zstd --stdin-name pd.dump "::$ARCHIVE" -
fi
run borg prune "${RETENTION_ARGS[@]}" --glob-archives 'pd-*'
run borg compact

if (( OFFSITE )); then
  run bash "$SCRIPT_DIR/../../ops/backup/offsite-sync.sh" ${PD_TENANT:+--tenant "$PD_TENANT"}
else
  log "off-site copy skipped (--no-offsite)"
fi
log "OK $(date -u +%FT%TZ)"
