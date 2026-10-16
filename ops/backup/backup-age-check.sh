#!/usr/bin/env bash
# ops/backup/backup-age-check.sh - fail when the newest backup or the last off-site copy is too old (runs ON THE SERVER,
# as root; pd-backup-check.timer starts it every 30 minutes, see ops/install.sh). Plan 01 s4: RPO 1 hour.
#
# Reads [backup] max_backup_age_hours (default 2) and checks:
#   - the newest REGULAR Borg archive (pd-<UTC %Y-%m-%dT%H:%M:%S>; -pre-restore copies and .checkpoints do not count)
#   - /mnt/pdbackup/pd/last-offsite-ok, written by ops/backup/offsite-sync.sh only after a complete B2 sync (time=)
# Exit 0: both are fresh. Exit 1: either is older than the limit, missing or unreadable. A failure of this unit (and of
# pd-backup.service) starts pd-alert@<unit>.service through OnFailure= (ops/backup/alert.sh).
#
# It catches what a failing pd-backup.service cannot report by itself: a timer that was disabled or never ran, a sync
# refused every hour, a clock that stopped. Read-only: it never writes to the repository or to B2.
#
# Usage: sudo ops/backup/backup-age-check.sh [--dry-run] [--tenant PATH] [--now EPOCH]
#   --now EPOCH   the current time in seconds (tests only)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../infra/lib/ops-common.sh
source "$HERE/../../infra/lib/ops-common.sh"
# shellcheck source=../lib/backup-common.sh
source "$HERE/../lib/backup-common.sh"
usage() { ops_usage "${BASH_SOURCE[0]}"; }

ops_init backup-age-check "$@"
NOW=""
set -- ${OPS_ARGS[@]+"${OPS_ARGS[@]}"}
while (( $# )); do
  case "$1" in
    --now) NOW="${2:?--now needs seconds}"; shift ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done
[[ -z "$NOW" || "$NOW" =~ ^[0-9]+$ ]] || die "--now takes seconds since 1970"
NOW="${NOW:-$(date -u +%s)}"
require_root

MAX_H="$(tenant_get backup.max_backup_age_hours 2)"
[[ "$MAX_H" =~ ^[0-9]+$ && "$MAX_H" -gt 0 ]] || die "[backup] max_backup_age_hours must be a whole number of hours > 0 (got '$MAX_H')"
MAX_S=$((MAX_H * 3600))
MARKER="$PD_BACKUP_MOUNT/pd/last-offsite-ok"

if is_dry; then
  log "[dry-run] would check that the newest regular Borg archive in $PD_BORG_REPO and $MARKER are at most ${MAX_H} h old"
  exit 0
fi
bk_check_mount
bk_check_pass
bk_borg_env

# age_of LABEL ISO-UTC-TIME: prints the age in seconds; fails on a time date cannot read
age_of() {
  local t
  t="$(date -u -d "$2" +%s 2>/dev/null)" || { echo "unreadable time '$2' for $1" >&2; return 1; }
  echo $((NOW - t))
}
fmt_age() { printf '%dh%02dm' $(($1 / 3600)) $((($1 % 3600) / 60)); }

problems=()
latest="$(bk_latest_archive)" || { problems+=("borg list failed: the repository cannot be read"); latest=""; }
if [[ -z "$latest" ]]; then
  [[ ${#problems[@]} -gt 0 ]] || problems+=("no regular archive in $PD_BORG_REPO")
else
  ts="${latest#pd-}"
  if a="$(age_of "$latest" "$ts")"; then
    if (( a > MAX_S )); then problems+=("newest archive $latest is $(fmt_age "$a") old (limit ${MAX_H} h)"); else log "newest archive $latest: $(fmt_age "$a") old"; fi
  else
    problems+=("cannot read the time of archive $latest")
  fi
fi

if [[ -f "$MARKER" ]]; then
  # time=<ISO> since the machine check; older markers held only the time on the first line
  mt="$(sed -n 's/^time=//p' "$MARKER" | head -1)"
  [[ -n "$mt" ]] || mt="$(head -1 "$MARKER")"
  if a="$(age_of last-offsite-ok "$mt")"; then
    if (( a > MAX_S )); then problems+=("last complete off-site copy ($MARKER) is $(fmt_age "$a") old (limit ${MAX_H} h)"); else log "last off-site copy: $(fmt_age "$a") old"; fi
  else
    problems+=("cannot read the time in $MARKER")
  fi
else
  problems+=("$MARKER is missing: no complete off-site copy was ever made from this server")
fi

if (( ${#problems[@]} )); then
  for p in "${problems[@]}"; do printf '[backup-age-check] STALE: %s\n' "$p" >&2; done
  exit 1
fi
log "OK: backups and the off-site copy are within ${MAX_H} h"
