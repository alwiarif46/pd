#!/usr/bin/env bash
# ops/backup/offsite-sync.sh - copy the Borg repository /mnt/pdbackup/borg to Backblaze B2 through rclone crypt
# (docs/plans/01-infrastructure.md s4; Drive PR #3 ops/backup/offsite-sync.sh without the AIO and ransomware
# manifest parts - the segment-manifest guard is a follow-up, see ops/backup/README.md). Called by
# infra/scripts/backup.sh after every backup; can also run alone.
#
# Failure modes it guards against (data loss in B2 first):
#   - /mnt/pdbackup not mounted from /dev/mapper/pdbackup: an empty mount point synced with "sync" would hide every
#     object in B2. Refuses.
#   - the source is empty or not a Borg repository (no 'config' file). Refuses.
#   - the local file count is below --min-ratio (default 50) percent of what B2 already holds (a wiped or wrong
#     source). Refuses.
#   - rclone.conf with hard_delete = true, or a crypt remote that is not b2:<[backup] bucket>/<[backup] crypt_prefix>.
#     Always passes --b2-hard-delete=false; removed files are only hidden (the bucket lifecycle expires them).
#   - the repository is mid-write: waits up to --wait-min (default 30) for lock.exclusive / lock.roster to clear.
# Secrets: the B2 key and the (obscured) crypt passwords come only from /etc/pd/rclone.env (0600) as rclone's
# RCLONE_CONFIG_B2_ACCOUNT, _B2_KEY, _B2CRYPT_PASSWORD and _B2CRYPT_PASSWORD2; /etc/pd/rclone.conf has no secrets.
# They never appear in argv or in output. A full successful run writes pd/last-offsite-ok and uploads it LAST, so its
# time in B2 marks a consistent point if a sync dies half way.
#
# Usage: sudo ops/backup/offsite-sync.sh [--dry-run] [--wait-min N] [--min-ratio PCT] [--tenant PATH]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../infra/lib/ops-common.sh
source "$HERE/../../infra/lib/ops-common.sh"
# shellcheck source=../lib/backup-common.sh
source "$HERE/../lib/backup-common.sh"
usage() { ops_usage "${BASH_SOURCE[0]}"; }

ops_init offsite-sync "$@"
WAIT_MIN=30 MIN_RATIO=50
set -- ${OPS_ARGS[@]+"${OPS_ARGS[@]}"}
while (( $# )); do
  case "$1" in
    --wait-min) WAIT_MIN="${2:?}"; shift ;;
    --min-ratio) MIN_RATIO="${2:?}"; shift ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done
[[ "$WAIT_MIN" =~ ^[0-9]+$ && "$MIN_RATIO" =~ ^[0-9]+$ ]] || die "--wait-min and --min-ratio take numbers"
require_root
require_cmd rclone

BUCKET="$(tget backup.bucket)"
PREFIX="$(tget backup.crypt_prefix)"
RCLONE_CONF="$PD_ETC/rclone.conf"
RCLONE_ENV="$PD_ETC/rclone.env"
MARKER_DIR="$PD_BACKUP_MOUNT/pd"
MARKER="$MARKER_DIR/last-offsite-ok"

if ! is_dry; then
  mkdir -p "$PD_LOG_DIR"
  exec > >(tee -a "$PD_LOG_DIR/offsite-sync.log") 2>&1
fi
log "start $(date -u +%FT%TZ)"

# --- guards (a real run stops at the first one; --dry-run reports every one and goes on)
src="$(findmnt -no SOURCE "$PD_BACKUP_MOUNT" 2>/dev/null || true)"
[[ "$src" == "$PD_BACKUP_MAPPER" ]] || bk_guard "$PD_BACKUP_MOUNT is not mounted from $PD_BACKUP_MAPPER (found: '${src:-not mounted}'); refusing to sync an empty mount point"
if [[ -d "$PD_BORG_REPO" && -n "$(ls -A "$PD_BORG_REPO" 2>/dev/null)" ]]; then
  [[ -f "$PD_BORG_REPO/config" ]] || bk_guard "$PD_BORG_REPO has no borg 'config' file: not a repository"
else
  bk_guard "$PD_BORG_REPO is missing or empty: nothing to sync (and an empty source must never be synced)"
fi
if [[ -f "$RCLONE_CONF" ]]; then
  if grep -Eq '^[[:space:]]*hard_delete[[:space:]]*=[[:space:]]*true' "$RCLONE_CONF"; then
    bk_guard "$RCLONE_CONF sets hard_delete = true: removed files must only be hidden"
  fi
  want_remote="b2:$BUCKET/$PREFIX"
  have_remote="$(awk '/^\[b2crypt\]/{s=1;next} /^\[/{s=0} s && /^[[:space:]]*remote[[:space:]]*=/{sub(/^[^=]*=[[:space:]]*/,""); sub(/[[:space:]\r]+$/,""); print}' "$RCLONE_CONF")"
  [[ "$have_remote" == "$want_remote" ]] || bk_guard "[b2crypt] remote is '$have_remote', tenant file says '$want_remote' (one prefix per instance)"
else
  bk_guard "missing $RCLONE_CONF (run ops/backup/rclone-setup.sh)"
fi
[[ "${RCLONE_B2_HARD_DELETE:-false}" =~ ^(1|true|TRUE|True)$ ]] && bk_guard "RCLONE_B2_HARD_DELETE is set to true in the environment"
KEYS=(RCLONE_CONFIG_B2_ACCOUNT RCLONE_CONFIG_B2_KEY RCLONE_CONFIG_B2CRYPT_PASSWORD RCLONE_CONFIG_B2CRYPT_PASSWORD2)
if bk_load_env_keys "$RCLONE_ENV" "${KEYS[@]}"; then
  for k in "${KEYS[@]}"; do [[ -n "${!k:-}" ]] || bk_guard "$k is empty in $RCLONE_ENV"; done
else
  bk_guard "missing $RCLONE_ENV (ops/backup/rclone-setup.sh)"
fi

RC=(rclone --config "$RCLONE_CONF")
SYNC_FLAGS=(--b2-hard-delete=false --fast-list --transfers 8 --checkers 16 --log-level INFO --stats 0
            --exclude 'lock.exclusive/**' --exclude lock.roster)

borg_busy() { [[ -e "$PD_BORG_REPO/lock.roster" || -e "$PD_BORG_REPO/lock.exclusive" ]]; }
local_count() { find "$1" -type f ! -name lock.roster ! -path '*/lock.exclusive/*' 2>/dev/null | wc -l | tr -d ' '; }
remote_count() {
  # rclone size --json prints {"count":N,"bytes":M}; a missing directory counts as 0.
  local j
  j="$("${RC[@]}" size --json --fast-list "b2crypt:borg" 2>/dev/null)" || { echo 0; return 0; }
  printf '%s' "$j" | pyj 'd.get("count", 0)'
}

if is_dry; then
  log "[dry-run] would wait up to ${WAIT_MIN} min for lock.roster / lock.exclusive to clear"
  log "[dry-run] would compare the local file count with b2crypt:borg (refuse below ${MIN_RATIO}%)"
  run "${RC[@]}" sync "$PD_BORG_REPO" "b2crypt:borg" "${SYNC_FLAGS[@]}"
  log "[dry-run] then write $MARKER and upload it LAST to b2crypt:pd/last-offsite-ok"
  exit 0
fi

waited=0
while borg_busy; do
  if (( waited >= WAIT_MIN )); then die "the Borg repository is still locked after ${WAIT_MIN} min; not syncing a repository that is being written"; fi
  sleep 60; waited=$((waited + 1))
done
lc="$(local_count "$PD_BORG_REPO")"
rcnt="$(remote_count)"
if (( rcnt > 0 && lc * 100 < rcnt * MIN_RATIO )); then
  die "$PD_BORG_REPO has $lc files but B2 holds $rcnt (< ${MIN_RATIO}%); refusing to sync (wrong or wiped source?). Override only after checking: --min-ratio 0"
fi
run "${RC[@]}" sync "$PD_BORG_REPO" "b2crypt:borg" "${SYNC_FLAGS[@]}"
log "synced borg ($lc local files)"
# The marker goes up LAST, only after the sync succeeded.
mkdir -p "$MARKER_DIR"
date -u +%FT%TZ >"$MARKER"
run "${RC[@]}" copyto "$MARKER" "b2crypt:pd/last-offsite-ok" --b2-hard-delete=false
log "OK $(date -u +%FT%TZ)"
