#!/usr/bin/env bash
# infra/providers/ovh-us/break-glass.sh
# Implements: docs/plans/01-infrastructure.md section 4.1 "Break-glass" on OVHcloud US Public Cloud
# (Drive D-137): out-of-band access when the admin network (Headscale on the Hetzner host) is down.
#
#   console                          print the noVNC console URL (log in as the admin user with the
#                                    password from the password manager; the console keyboard may be
#                                    US layout and has no paste, hence the word passphrase)
#   status                           server state (ACTIVE / RESCUE), lock, security groups
#   rescue --confirm-reboot [--image NAME] [--ip IP]
#                                    reboot into OVH rescue mode. DISRUPTIVE (PD is down) and
#                                    EXPOSED: the rescue system runs no host firewall, accepts password SSH
#                                    (temporary password shown in the VNC console) and sees the root disk
#                                    with the LUKS keyfiles. So it refuses unless every public port has
#                                    port security on, the server has only PD security group, and
#                                    that group has no TCP 22 rule except one single-IP rule for the
#                                    admin IP (--ip, default ADMIN_IP). The server is re-locked right
#                                    after the rescue call (and on any failure). Do not leave rescue running.
#   unrescue                         MANDATORY after rescue: unlock, leave rescue mode, lock again
#
# Common flags: --dry-run  --tenant PATH  --secrets PATH  -h
# Same as the OVHcloud Control Panel: Instances > ... > "VNC console" / "Reboot in rescue mode" /
# "Exit rescue mode" (support.us.ovhcloud.com, "How to activate rescue mode on a Public Cloud
# instance"). The Control Panel works even when this machine has no OpenStack credential.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../lib/tenant.sh
. "$SCRIPT_DIR/../../lib/tenant.sh"
# shellcheck source=../../lib/openstack.sh
. "$SCRIPT_DIR/../../lib/openstack.sh"

usage() {
  sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
}

ACTION="" CONFIRM=0 IMAGE="" IP_ARG=""
pd_parse_args "$@"
set -- ${PD_REST[@]+"${PD_REST[@]}"}
while (( $# )); do
  case "$1" in
    console | status | rescue | unrescue) [[ -z "$ACTION" ]] || pd_die "only one action"; ACTION="$1" ;;
    --ip) IP_ARG="${2:?--ip needs a value}"; shift ;;
    --confirm-reboot) CONFIRM=1 ;;
    --image) IMAGE="${2:?--image needs a value}"; shift ;;
    *) pd_die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done
[[ -n "$ACTION" ]] || { usage; pd_die "action required: console | status | rescue | unrescue"; }

os_provider_check
HOST="$(tenant_get tenant.hostname)"
SG="$(tenant_get infra.security_group)"
load_secrets
os_env
os_check_project
pd_find_python
OSTOOL=("$PD_PY" "$(pd_native_path "$SCRIPT_DIR/ostool.py")")

RELOCK=0
relock() { if (( RELOCK )); then openstack server lock "$HOST" >/dev/null 2>&1 || pd_warn "could not re-lock $HOST: run 'openstack server lock $HOST' now"; RELOCK=0; fi; }
trap relock EXIT

warn_unlocked() {
  (( PD_DRY_RUN )) && return 0
  local j
  j="$(openstack server show "$HOST" -f json)" || return 0
  if [[ "$(printf '%s' "$j" | pyj 'str(d.get("locked")).lower()')" != "true" ]]; then
    pd_warn "$HOST is UNLOCKED (leaving rescue from the Control Panel does that): openstack server lock $HOST"
  fi
  if [[ "$(printf '%s' "$j" | pyj 'd.get("status") or ""')" == RESCUE ]]; then
    pd_warn "$HOST is in RESCUE mode: finish and run break-glass.sh unrescue"
  fi
}

rescue_preflight() {
  local port pse sgs cidr="" others raw_ip="${IP_ARG:-${ADMIN_IP:-}}"
  if [[ -n "$raw_ip" ]]; then cidr="$("${OSTOOL[@]}" cidr "$raw_ip")" || pd_die "cannot use '$raw_ip' as the admin IP"; fi
  if (( PD_DRY_RUN )); then
    echo "[dry-run] would check: port security on every port of $HOST, only security group $SG, no TCP 22 rule except ${cidr:-<none>}"
    return 0
  fi
  while read -r port; do
    [[ -n "$port" ]] || continue
    pse="$(openstack port show "$port" -f value -c port_security_enabled | tr -d '\r')"
    [[ "${pse,,}" == true ]] || pd_die "refusing rescue: port $port has port security disabled, so the security group would not shield the password-SSH rescue system"
  done < <(openstack port list --server "$HOST" -f value -c ID | tr -d '\r')
  sgs="$(openstack server show "$HOST" -f json | pyj '",".join(sorted({(g.get("name") if isinstance(g, dict) else str(g)) for g in (d.get("security_groups") or [])}))')"
  [[ "$sgs" == "$SG" ]] || pd_die "refusing rescue: $HOST has security groups '$sgs', expected only '$SG'"
  others="$(openstack security group show "$SG" -f json | "${OSTOOL[@]}" sg-ssh-rules ${cidr:+--except "$cidr"})"
  [[ -z "$others" ]] || pd_die "refusing rescue: $SG has TCP 22 rules other than a single rule for ${cidr:-<admin IP>}: $others"
  echo "rescue preflight ok: port security on, only $SG, TCP 22 only from ${cidr:-nowhere (VNC console only)}"
}

case "$ACTION" in
  console)
    warn_unlocked
    run openstack console url show --novnc "$HOST"
    echo "The URL is short-lived and grants console access: do not paste it anywhere."
    ;;
  status)
    run openstack server show "$HOST" -c status -c locked -c security_groups
    warn_unlocked
    ;;
  rescue)
    (( CONFIRM )) || pd_die "rescue reboots $HOST and takes PD offline: re-run with --confirm-reboot"
    rescue_preflight
    img=(); [[ -n "$IMAGE" ]] && img=(--image "$IMAGE")
    run openstack server unlock "$HOST"
    (( PD_DRY_RUN )) || RELOCK=1
    run openstack server rescue "${img[@]}" "$HOST"
    relock
    (( PD_DRY_RUN )) && echo "[dry-run] then re-lock: openstack server lock $HOST"
    cat <<EOT
Rescue mode requested; the server is locked again. DO NOT LEAVE RESCUE RUNNING: no host firewall,
password SSH, and the root disk with the LUKS keyfiles are exposed while it runs.
  1. break-glass.sh console  -> the temporary rescue password is shown in the VNC console
  2. log in, lsblk, mount the root disk (usually /dev/sdb1) on /mnt; repair; never luksFormat anything
  3. MANDATORY: break-glass.sh unrescue  (reboots into the normal system and locks the server again)
EOT
    ;;
  unrescue)
    run openstack server unlock "$HOST"
    (( PD_DRY_RUN )) || RELOCK=1
    run openstack server unrescue "$HOST"
    relock
    (( PD_DRY_RUN )) && echo "[dry-run] then re-lock: openstack server lock $HOST"
    echo "Left rescue mode; $HOST is locked. Check PD came back (plan 01 check 6)."
    ;;
esac
