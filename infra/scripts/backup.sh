#!/usr/bin/env bash
# infra/scripts/backup.sh - encrypted database backup (runs ON THE SERVER, as root; hourly via systemd timer).
# Implements: docs/plans/01-infrastructure.md s4 (Drive PR #3 backup design, PD runs Borg itself).
#
#   borg create --content-from-command --stdin-name pd.dump ::pd-<UTC time> -- docker compose ... pg_dump -Fc
#     -> /mnt/pdbackup/borg (LUKS volume, encrypted repo; borg >= 1.2, Ubuntu 24.04 ships 1.2.8)
#   then the archive is checked (bk_validate_archive: the whole pd.dump through pg_restore --file=/dev/null),
#   then borg prune (retention from [backup] borg_retention), borg compact,
#   then ops/backup/offsite-sync.sh (rclone crypt copy to Backblaze B2) unless --no-offsite.
#
# Why --content-from-command and not `pg_dump | borg create -`: with a pipe, borg only sees its stdin end and COMMITS
# the empty or truncated stream as a good archive (exit 0) when pg_dump dies; prune could then keep only empty
# archives and the off-site sync would copy them. With --content-from-command borg runs pg_dump itself and aborts the
# archive when pg_dump exits non-zero. Belt and braces: if borg create fails, or the new archive does not validate,
# the archive (and any NAME.checkpoint) is deleted, and the script stops before prune and the off-site copy.
# It also passes the compose file and env file explicitly (the old script failed unless run next to a compose file),
# and the dump is never a plain, unencrypted .sql.gz on the same disk.
# One run at a time: the whole run holds flock on $PD_BACKUP_LOCK (default /run/pd-backup.lock), waiting up to
# $PD_BACKUP_LOCK_WAIT seconds (default 1800) and then refusing, and the archive name is chosen under the lock. So the
# hourly timer, a manual run and restore.sh's safety backup never overlap, and the clean-up can only ever delete this
# run's archive. A create that fails with "already exists" deletes nothing.
# Refuses unless /mnt/pdbackup is mounted from /dev/mapper/pdbackup (under --dry-run it only warns) and
# /etc/pd/borg.pass is root, mode 0400. The passphrase goes to borg through BORG_PASSCOMMAND only: never in
# argv, never in the environment. Nothing is written to /tmp or /data/backups. Live files are not backed up
# (plan 01 s4): the database is.
#
# Usage: sudo infra/scripts/backup.sh [--init] [--no-offsite] [--adopt-offsite] [--tag NAME] [--dry-run] [--tenant PATH]
#   --init        create the Borg repository (repokey-blake2) and export its key to /etc/pd/borg-key.txt (0400)
#   --no-offsite  skip the B2 copy (restore.sh uses this for its safety backup)
#   --adopt-offsite  passed to offsite-sync.sh: take the B2 prefix over from another machine (once, after a move)
#   --tag NAME    append -NAME to the archive name (restore.sh: pre-restore)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/ops-common.sh
source "$SCRIPT_DIR/../lib/ops-common.sh"
# shellcheck source=../../ops/lib/backup-common.sh
source "$SCRIPT_DIR/../../ops/lib/backup-common.sh"
usage() { ops_usage "${BASH_SOURCE[0]}"; }

ops_init backup "$@"
INIT=0 OFFSITE=1 ADOPT=0 TAG=""
set -- ${OPS_ARGS[@]+"${OPS_ARGS[@]}"}
while (( $# )); do
  case "$1" in
    --init) INIT=1 ;;
    --no-offsite) OFFSITE=0 ;;
    --adopt-offsite) ADOPT=1 ;;
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

LOCK="${PD_BACKUP_LOCK:-/run/pd-backup.lock}"
LOCK_WAIT="${PD_BACKUP_LOCK_WAIT:-1800}"
[[ "$LOCK_WAIT" =~ ^[0-9]+$ ]] || die "PD_BACKUP_LOCK_WAIT must be seconds"
if ! is_dry; then
  require_cmd flock
  exec 9>>"$LOCK" || die "cannot open the lock file $LOCK"
  flock -w "$LOCK_WAIT" 9 || die "another backup.sh holds $LOCK (waited ${LOCK_WAIT}s): not starting a second run"
fi

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

ARCHIVE="$(bk_new_archive_name "$TAG")"
DUMP=("${COMPOSE[@]}" exec -T postgres pg_dump -U pd_owner -d pd -Fc)
if is_dry; then
  echo "[dry-run] borg create --compression zstd --content-from-command --stdin-name pd.dump ::$ARCHIVE -- ${DUMP[*]}"
  echo "[dry-run] borg extract --stdout ::$ARCHIVE pd.dump | ${COMPOSE[*]} exec -T postgres pg_restore --file=/dev/null   (validate; a bad archive is deleted)"
else
  # Never reuse a name: the clean-up below deletes by name, and it must only ever delete what this run wrote.
  existing="$(borg list --short)" || die "borg list failed: is the repository there ($PD_BORG_REPO)?"
  if grep -qxF -- "$ARCHIVE" <<<"$existing"; then die "archive $ARCHIVE already exists; try again in a second"; fi
  # Nothing is written to disk in plaintext: borg reads pg_dump's stdout itself.
  crc=0
  create_out="$(borg create --compression zstd --content-from-command --stdin-name pd.dump "::$ARCHIVE" -- "${DUMP[@]}" 2>&1)" || crc=$?
  [[ -z "$create_out" ]] || printf '%s\n' "$create_out" >&2
  if (( crc != 0 )); then
    # "already exists": the archive of that name is someone else's, never ours to delete
    if grep -q "already exists" <<<"$create_out"; then die "archive $ARCHIVE already exists (another run?): nothing deleted; no prune, no off-site copy"; fi
    bk_drop_archive "$ARCHIVE" || true
    die "pg_dump or borg create failed: no archive $ARCHIVE kept; no prune, no off-site copy"
  fi
  if ! bk_validate_archive "$ARCHIVE" "${COMPOSE[@]}" exec -T postgres; then
    bk_drop_archive "$ARCHIVE" || die "archive $ARCHIVE is not a readable pg_dump AND could not be deleted: delete it by hand before the next prune (borg delete ::$ARCHIVE)"
    die "archive $ARCHIVE is not a readable pg_dump (pg_restore rejected it): deleted; no prune, no off-site copy"
  fi
  log "archive $ARCHIVE created and validated"
fi
run borg prune "${RETENTION_ARGS[@]}" --glob-archives 'pd-*'
run borg compact

if (( OFFSITE )); then
  OFFSITE_ARGS=(); (( ADOPT )) && OFFSITE_ARGS+=(--adopt-offsite)
  run bash "$SCRIPT_DIR/../../ops/backup/offsite-sync.sh" ${PD_TENANT:+--tenant "$PD_TENANT"} ${OFFSITE_ARGS[@]+"${OFFSITE_ARGS[@]}"}
else
  log "off-site copy skipped (--no-offsite)"
fi
log "OK $(date -u +%FT%TZ)"
