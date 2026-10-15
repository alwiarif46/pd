#!/usr/bin/env bash
# infra/providers/hetzner/firewall-temp-ssh.sh - plan 01 on the Hetzner firewall: ONE
# temporary TCP 22 rule from the admin's public IP for the first-boot window, removed once SSH over the
# admin network works. The host firewall is the second layer (infra/server/host-firewall.sh).
# Usage:
#   infra/firewall-temp-ssh.sh add    [--ip IP]            (default: ADMIN_IP from the secrets file)
#   infra/firewall-temp-ssh.sh remove --check-host HOST    remove every TCP 22 rule after the admin-network check
#   infra/firewall-temp-ssh.sh remove --no-check           same without the check (lockout risk)
# Common flags: --dry-run  --tenant PATH  --secrets PATH  -h
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/hz-common.sh"
usage() { hz_usage "${BASH_SOURCE[0]}"; }
ACTION="" IP_ARG="" CHECK_HOST="" NO_CHECK=0
pd_parse_args "$@"
set -- ${PD_REST[@]+"${PD_REST[@]}"}
while (( $# )); do
  case "$1" in
    add | remove) [[ -z "$ACTION" ]] || pd_die "only one action allowed"; ACTION="$1" ;;
    --ip) IP_ARG="${2:?--ip needs a value}"; shift ;;
    --check-host) CHECK_HOST="${2:?--check-host needs a value}"; shift ;;
    --no-check) NO_CHECK=1 ;;
    *) pd_die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done
[[ -n "$ACTION" ]] || { usage; pd_die "action required: add | remove"; }
hz_init
(( PD_DRY_RUN )) && load_secrets
case "$ACTION" in
  add)
    raw="${IP_ARG:-${ADMIN_IP:-}}"
    if [[ -n "$raw" ]]; then
      cidr="$("$PD_PY" "$(pd_native_path "$PD_LIB_DIR/netutil.py")" cidr "$raw")" || pd_die "cannot use '$raw' as the admin SSH source"
    elif (( PD_DRY_RUN )); then cidr="<ADMIN_IP>/32"
    else pd_die "no IP: pass --ip IP or set ADMIN_IP in the secrets file"; fi
    if (( PD_DRY_RUN )); then echo "[dry-run] Hetzner firewall $(tenant_get infra.hetzner.firewall fw-pd): add TCP 22 from $cidr"; exit 0; fi
    hz_py temp-ssh add --cidr "$cidr"
    echo "Host firewall: the first-boot window admits ADMIN_IP for [infra] bootstrap_ssh_hours only; later windows"
    echo "also need, on the server: sudo infra/server/host-firewall.sh allow-ssh --ip ${cidr%/*}"
    echo "REMINDER: keep the window short; then: infra/firewall-temp-ssh.sh remove --check-host <admin-network name>"
    ;;
  remove)
    provider_admin_ssh_check "$CHECK_HOST" "$NO_CHECK"
    if (( PD_DRY_RUN )); then echo "[dry-run] would remove every TCP 22 rule from the Hetzner firewall and verify none is left"; exit 0; fi
    hz_py temp-ssh remove
    echo "STATE.md: | $(date +%F) | 01 | §4 step 3 | done | Temporary TCP 22 rule removed from the Hetzner firewall after admin-network SSH worked; verified none remains. |"
    ;;
esac
