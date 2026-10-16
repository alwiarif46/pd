#!/usr/bin/env bash
# ops/install.sh - install the PD systemd timers (runs ON THE SERVER, as root).
# Renders ops/systemd/*.service.template and *.timer.template into /etc/systemd/system, then
# daemon-reload and enable --now the timers (docs/plans/01-infrastructure.md s4):
#   pd-backup.timer        hourly encrypted database backup (OnFailure= -> pd-alert@pd-backup.service)
#   pd-backup-check.timer  every 30 min: fails when the newest archive or last-offsite-ok is older than
#                          [backup] max_backup_age_hours (OnFailure= -> pd-alert@pd-backup-check.service)
#   pd-alert@.service      records the failure (ops/backup/alert.sh; notifier hook: HUMAN-TODO H-11)
# Idempotent: unchanged units are left alone.
#
# Usage: sudo ops/install.sh [--dry-run] [--tenant PATH]
# Test overrides: PD_UNIT_DIR (default /etc/systemd/system), PD_PROJECT_DIR.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../infra/lib/ops-common.sh
source "$HERE/../infra/lib/ops-common.sh"
usage() { ops_usage "${BASH_SOURCE[0]}"; }

ops_init install "$@"
(( ${#OPS_ARGS[@]} == 0 )) || die "unknown argument: ${OPS_ARGS[0]} (see --help)"
require_root
UNIT_DIR="${PD_UNIT_DIR:-/etc/systemd/system}"
PROJECT_DIR="${PD_PROJECT_DIR:-$(tenant_get backup.project_dir /opt/pd)}"

changed=0
for unit in pd-backup.service pd-backup.timer pd-backup-check.service pd-backup-check.timer pd-alert@.service; do
  tpl="$HERE/systemd/$unit.template"
  [[ -f "$tpl" ]] || die "missing template $tpl"
  dest="$UNIT_DIR/$unit"
  before=""; [[ -f "$dest" ]] && before="$(cat "$dest")"
  ops_install_cmd "$dest" 0644 root:root ops_render "$tpl" "PROJECT_DIR=$PROJECT_DIR"
  if [[ "$before" != "$(cat "$dest" 2>/dev/null || true)" ]]; then changed=1; fi
done
if (( changed )) || is_dry; then run systemctl daemon-reload; fi
run systemctl enable --now pd-backup.timer pd-backup-check.timer
echo "Installed. Next runs: systemctl list-timers 'pd-backup*'   Open alerts: ops/backup/alert.sh --status"
