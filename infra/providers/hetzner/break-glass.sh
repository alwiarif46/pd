#!/usr/bin/env bash
# infra/providers/hetzner/break-glass.sh - plan 01 on Hetzner Cloud: out-of-band access when
# the admin network is down.
#   console                         where to open the web console (the API console password is not printed)
#   status                          server status, rescue flag, type, location, protection, firewalls
#   rescue --confirm-reboot [--ip IP]
#                                   reboot into the Hetzner rescue system with the admin's SSH key. DISRUPTIVE
#                                   and EXPOSED (no host firewall there; the root disk with the LUKS keyfiles is
#                                   visible), so it refuses unless the Hetzner firewall's only TCP 22 rule is a
#                                   single-IP rule for the admin IP (--ip, default ADMIN_IP). Always `unrescue`.
#   unrescue                        MANDATORY after rescue: leave rescue mode and reboot normally
# Common flags: --dry-run  --tenant PATH  --secrets PATH  -h
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/hz-common.sh"
usage() { hz_usage "${BASH_SOURCE[0]}"; }
ACTION="" CONFIRM=0 IP_ARG=""
pd_parse_args "$@"
set -- ${PD_REST[@]+"${PD_REST[@]}"}
while (( $# )); do
  case "$1" in
    console | status | rescue | unrescue) ACTION="$1" ;;
    --confirm-reboot) CONFIRM=1 ;;
    --ip) IP_ARG="${2:?--ip needs a value}"; shift ;;
    *) pd_die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done
[[ -n "$ACTION" ]] || { usage; pd_die "action required"; }
hz_init
if (( PD_DRY_RUN )); then echo "[dry-run] Hetzner break-glass $ACTION (no API call)"; exit 0; fi
case "$ACTION" in
  rescue)
    raw="${IP_ARG:-${ADMIN_IP:-}}"; [[ -n "$raw" ]] || pd_die "no admin IP: --ip IP or ADMIN_IP"
    cidr="$("$PD_PY" "$(pd_native_path "$PD_LIB_DIR/netutil.py")" cidr "$raw")" || pd_die "bad admin IP"
    args=(rescue --cidr "$cidr"); (( CONFIRM )) && args+=(--confirm-reboot)
    hz_py "${args[@]}" ;;
  *) hz_py "$ACTION" ;;
esac
