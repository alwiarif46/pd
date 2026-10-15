#!/usr/bin/env bash
# ops/install.sh - install the PD systemd timers (runs ON THE SERVER, as root).
# Renders ops/systemd/*.service.template and *.timer.template into /etc/systemd/system, then
# daemon-reload and enable --now the timers. Today that is one timer: pd-backup (hourly encrypted database backup,
# docs/plans/01-infrastructure.md s4). Idempotent: unchanged units are left alone.
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
for name in pd-backup; do
  for kind in service timer; do
    tpl="$HERE/systemd/$name.$kind.template"
    [[ -f "$tpl" ]] || die "missing template $tpl"
    dest="$UNIT_DIR/$name.$kind"
    before=""; [[ -f "$dest" ]] && before="$(cat "$dest")"
    ops_render "$tpl" "PROJECT_DIR=$PROJECT_DIR" | ops_install_file "$dest" 0644 root:root
    if [[ "$before" != "$(cat "$dest" 2>/dev/null || true)" ]]; then changed=1; fi
  done
done
if (( changed )) || is_dry; then run systemctl daemon-reload; fi
run systemctl enable --now pd-backup.timer
echo "Installed. Next run: systemctl list-timers pd-backup.timer"
