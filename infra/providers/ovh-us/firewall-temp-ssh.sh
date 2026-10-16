#!/usr/bin/env bash
# infra/providers/ovh-us/firewall-temp-ssh.sh
# Implements: docs/plans/01-infrastructure.md section 4 "After first boot" steps 2-3 and s3
# ("No public SSH"), on the OVHcloud security group (infra.security_group, Drive D-135). The server
# joins the Headscale admin network only after first boot, so for that window - and only that window -
# this script adds ONE ingress TCP 22 rule from the admin's current public IP (/32 or /128) to the
# security group. `remove` deletes every ingress rule that covers TCP 22 and proves none is left.
#
# Two layers: the server's host firewall (infra/server/host-firewall.sh) also admits SSH on the public
# interface only from ADMIN_IP, and only for [infra] bootstrap_ssh_hours after first boot (cloud-init
# puts ADMIN_IP into a timed nftables set). A later window from another IP needs both: this `add`
# and, on the server, `sudo infra/server/host-firewall.sh allow-ssh --ip IP` (from the console).
#
# Usage:
#   firewall-temp-ssh.sh add    [--ip IP]            add TCP 22 from IP/32 (default: ADMIN_IP in secrets file)
#   firewall-temp-ssh.sh remove --check-host HOST    remove every ingress TCP 22 rule, then verify
#   firewall-temp-ssh.sh remove --no-check           same, WITHOUT proving admin-network SSH first (lockout risk)
# Common flags: --dry-run  --tenant PATH  --secrets PATH  -h
#
# `remove` requires `--check-host HOST` (or the explicit `--no-check`). With --check-host, HOST is
# resolved first and must land inside 100.64.0.0/10 or fd7a:115c:a1e0::/48 (the admin network);
# anything else (the public IP, a Cloudflare name) is refused. Then it runs
# `ssh -o HostKeyAlias=HOST pdadmin@<resolved tailnet IP> true` (key only, 8 s timeout) and keeps the
# rule if that fails. Every other rule stays exactly as it is. Both actions are idempotent.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../lib/tenant.sh
. "$SCRIPT_DIR/../../lib/tenant.sh"
# shellcheck source=../../lib/openstack.sh
. "$SCRIPT_DIR/../../lib/openstack.sh"

usage() {
  sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
}

IP_ARG=""
CHECK_HOST=""
NO_CHECK=0
ACTION=""
pd_parse_args "$@"
set -- ${PD_REST[@]+"${PD_REST[@]}"}
while (( $# )); do
  case "$1" in
    add | remove)
      [[ -z "$ACTION" ]] || pd_die "only one action allowed"
      ACTION="$1" ;;
    --ip)
      [[ $# -ge 2 ]] || pd_die "--ip needs a value"
      IP_ARG="$2"; shift ;;
    --check-host)
      [[ $# -ge 2 ]] || pd_die "--check-host needs a value"
      CHECK_HOST="$2"; shift ;;
    --no-check) NO_CHECK=1 ;;
    *) pd_die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done
[[ -n "$ACTION" ]] || { usage; pd_die "action required: add | remove"; }

os_provider_check
SG="$(tenant_get infra.security_group)"
ADMIN_USER="$(tenant_get server.admin_user)"
load_secrets
os_env
os_check_project
pd_find_python
OSTOOL=("$PD_PY" "$(pd_native_path "$SCRIPT_DIR/ostool.py")")
# created=<epoch> lets ostool.py sg-drift / sg-stale-ssh report the rule's age (drill.sh status warns
# when it is older than [infra] bootstrap_ssh_hours; plan 01 acceptance check 3 fails while it exists).
DESC="TEMP admin SSH created=$(date -u +%s) - remove once admin-network SSH works (plan 01)"

rules_json() { openstack security group show "$SG" -f json; }

case "$ACTION" in
  add)
    raw_ip="${IP_ARG:-${ADMIN_IP:-}}"
    if [[ -n "$raw_ip" ]]; then
      cidr="$("${OSTOOL[@]}" cidr "$raw_ip")" || pd_die "cannot use '$raw_ip' as the admin SSH source"
    elif (( PD_DRY_RUN )); then
      cidr="<ADMIN_IP>/32"
      pd_log "note: no --ip and no ADMIN_IP set; previewing with a placeholder"
    else
      pd_die "no IP: pass --ip IP or set ADMIN_IP in the secrets file"
    fi
    eth=IPv4; [[ "$cidr" == *:* ]] && eth=IPv6
    echo "security group $SG: allow TCP 22 from $cidr only"
    if (( ! PD_DRY_RUN )) && rules_json | "${OSTOOL[@]}" sg-has-ssh "$cidr"; then
      echo "rule for $cidr already present - nothing to do"
    else
      run openstack security group rule create --ingress --ethertype "$eth" --protocol tcp --dst-port 22 \
        --remote-ip "$cidr" --description "$DESC" "$SG"
    fi
    echo
    echo "Host firewall: the first-boot window admits ADMIN_IP for [infra] bootstrap_ssh_hours only. For a"
    echo "later window from this IP also run on the server (console): sudo infra/server/host-firewall.sh allow-ssh --ip ${cidr%/*}"
    echo "REMINDER: this window must be short. As soon as SSH over the admin network works, run:"
    echo "  firewall-temp-ssh.sh remove --check-host <admin-network name or IP of the server>"
    ;;

  remove)
    if [[ -n "$CHECK_HOST" && $NO_CHECK -eq 1 ]]; then
      pd_die "give either --check-host HOST or --no-check, not both"
    fi
    if [[ -z "$CHECK_HOST" && $NO_CHECK -eq 0 ]]; then
      pd_die "remove needs --check-host <admin-network name or IP of the server> (or an explicit --no-check)"
    fi
    if [[ -n "$CHECK_HOST" ]]; then
      if tail_ip="$("${OSTOOL[@]}" tailnet-addr "$CHECK_HOST")"; then
        :
      elif (( PD_DRY_RUN )); then
        tail_ip="<tailnet-ip-of-$CHECK_HOST>"
        pd_warn "$CHECK_HOST does not resolve into the admin network from here (dry-run continues; a real run would refuse)"
      else
        pd_die "refusing: $CHECK_HOST must resolve into 100.64.0.0/10 or fd7a:115c:a1e0::/48 (admin network), not a public address. Are you on the tailnet?"
      fi
      echo "checking admin-network SSH: $ADMIN_USER@$CHECK_HOST ($tail_ip)"
      run ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new \
        -o HostKeyAlias="$CHECK_HOST" "$ADMIN_USER@$tail_ip" true \
        || pd_die "admin-network SSH to $CHECK_HOST ($tail_ip) failed; keeping the temporary rule so you are not locked out"
    else
      pd_warn "--no-check: NOT verifying admin-network SSH before removing the rule"
    fi
    if (( PD_DRY_RUN )); then
      echo "[dry-run] would list $SG rules and delete every ingress rule that covers TCP 22:"
      run openstack security group rule delete "<rule-id>"
      echo "[dry-run] then re-read the group and verify no TCP 22 rule remains"
    else
      found="$(rules_json | "${OSTOOL[@]}" sg-ssh-rules)"
      if [[ -z "$found" ]]; then
        echo "no TCP 22 rule present - nothing to remove"
      else
        echo "removing:"
        printf '%s\n' "$found" | sed 's/^/  /'
        while IFS=$'\t' read -r rid _; do
          [[ -n "$rid" ]] && run openstack security group rule delete "$rid"
        done <<<"$found"
      fi
      if [[ -n "$(rules_json | "${OSTOOL[@]}" sg-ssh-rules)" ]]; then
        pd_die "VERIFY FAILED: a TCP 22 rule still exists on $SG. Remove it in the OVHcloud Control Panel (Network > Security groups) now."
      fi
      echo "VERIFIED: $SG has no ingress TCP 22 rule."
      echo "Host firewall: the first-boot SSH element expires by itself; to close it now (over the admin network):"
      echo "  ssh -t $ADMIN_USER@<hostname> sudo ~/pd/infra/server/host-firewall.sh close-ssh"
      echo
      echo "Paste into STATE.md (Log):"
      echo "| $(date +%F) | 01 | §4 step 3 | done | Temporary TCP 22 rule removed from $SG after admin-network SSH worked; verified no TCP 22 rule remains. |"
    fi
    ;;
esac
