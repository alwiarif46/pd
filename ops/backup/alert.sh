#!/usr/bin/env bash
# ops/backup/alert.sh - record that a PD unit failed (runs ON THE SERVER, as root, from pd-alert@<unit>.service, which
# pd-backup.service and pd-backup-check.service name in OnFailure=).
#
# A simple status-unit approach with no external service:
#   - writes $PD_STATE_DIR/alerts/<unit>.failed (default /var/lib/pd/alerts): the time and the unit's last 50 journal lines
#   - logs one line at priority err to the journal (tag pd-alert), so `journalctl -p err` and any log shipper see it
#   - runs $PD_ETC/alert-hook <unit> <status file> when that file exists, is a regular file (not a symlink), is
#     executable, owned by root and not group- or world-writable. (Tests, running unprivileged, may set
#     PD_SKIP_OWNER_CHECK=1; it is ignored when the process really is root.) That hook is where a notifier (mail, ntfy, Uptime Kuma push, ...) plugs in: HUMAN-TODO H-11.
# The alert stays until an operator has looked: `ops/backup/alert.sh --status` lists them, `--clear UNIT` removes one.
#
# Usage: ops/backup/alert.sh UNIT | --status | --clear UNIT
set -euo pipefail

PD_ETC="${PD_ETC:-/etc/pd}"
ALERT_DIR="${PD_STATE_DIR:-/var/lib/pd}/alerts"
HOOK="$PD_ETC/alert-hook"

case "${1:-}" in
  "" | -h | --help) sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
  --status)
    shopt -s nullglob
    files=("$ALERT_DIR"/*.failed)
    if (( ${#files[@]} == 0 )); then echo "no open alerts"; exit 0; fi
    for f in "${files[@]}"; do printf '%s  %s\n' "$(head -1 "$f")" "$(basename "$f" .failed)"; done
    exit 1 ;;
  --clear)
    unit="${2:?--clear needs a unit name}"
    [[ "$unit" =~ ^[A-Za-z0-9@._:-]{1,120}$ ]] || { echo "bad unit name: $unit" >&2; exit 2; }
    rm -f "$ALERT_DIR/$unit.failed"; echo "cleared $unit"; exit 0 ;;
esac

unit="$1"
[[ "$unit" =~ ^[A-Za-z0-9@._:-]{1,120}$ ]] || { echo "bad unit name: $unit" >&2; exit 2; }
mkdir -p "$ALERT_DIR"
status="$ALERT_DIR/$unit.failed"
{
  echo "failed at $(date -u +%FT%TZ)"
  journalctl -u "$unit" -n 50 --no-pager 2>/dev/null || echo "(journalctl not available)"
} >"$status"
logger -p user.err -t pd-alert "PD unit $unit FAILED; details in $status (ops/backup/alert.sh --status)" 2>/dev/null || true

hook_owner_ok() {
  [[ "$(stat -c %U "$HOOK")" == root ]] && return 0
  [[ "${PD_SKIP_OWNER_CHECK:-0}" == 1 && "$EUID" != 0 ]]
}
if [[ -e "$HOOK" || -L "$HOOK" ]]; then
  if [[ ! -L "$HOOK" && -f "$HOOK" && -x "$HOOK" ]] && hook_owner_ok && ! stat -c %A "$HOOK" | grep -qE '^.{5}w|^.{8}w'; then
    "$HOOK" "$unit" "$status" || logger -p user.err -t pd-alert "alert hook $HOOK failed for $unit" 2>/dev/null || true
  else
    logger -p user.err -t pd-alert "ignoring $HOOK: it must be a regular file (no symlink), executable, owned by root, not group/world-writable" 2>/dev/null || true
  fi
fi
echo "alert recorded: $status"
