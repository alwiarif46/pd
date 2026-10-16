#!/usr/bin/env bash
# infra/providers/ssh/provision.sh - plan 01 for a machine that already exists and has no
# provider API (Drive D-146, D-147). Nothing is bought or created here: the server was ordered by hand
# ([infra.ssh] in config/tenant.toml names it). This step only PROBES it, read-only, over root SSH:
#   OS        must be Ubuntu 24.04 (lsb_release)
#   Disks     lsblk: one root disk is expected; storage is LUKS containers on it (D-147)
#   Addresses the IPv4/IPv6 on the box must match [infra.ssh] ipv4/ipv6 (they feed DNS)
#   Free disk enough for the [volumes] container sizes plus 20 GB for the OS, Docker and images
# Then: infra/server/bootstrap-existing.sh (applies infra/cloud-init.yaml to the running machine).
# Usage:
#   infra/provision.sh --dry-run                 print the probe commands
#   infra/provision.sh --confirm-purchase        run the probe (the flag is kept for one interface; nothing is bought)
# Common flags: --tenant PATH  --secrets PATH  -h
# Needs: root SSH with the admin key (the provider's first login; add the key with the provider's
# panel or `ssh-copy-id`). Firewall: host nftables only (no provider firewall API).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../lib/tenant.sh
. "$SCRIPT_DIR/../../lib/tenant.sh"
# shellcheck source=../../lib/provider.sh
. "$SCRIPT_DIR/../../lib/provider.sh"
usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }
CONFIRM=0
pd_parse_args "$@"
set -- ${PD_REST[@]+"${PD_REST[@]}"}
while (( $# )); do
  case "$1" in --confirm-purchase) CONFIRM=1 ;; *) pd_die "unknown argument: $1 (see --help)" ;; esac
  shift
done
(( PD_DRY_RUN || CONFIRM )) || pd_die "run with --dry-run (plan) or --confirm-purchase (probe; nothing is bought)"
[[ "$(tenant_get infra.provider)" == ssh ]] || pd_die "[infra] provider is not 'ssh'"
IP4="$(tenant_get infra.ssh.ipv4)"
IP6="$(tenant_get infra.ssh.ipv6 "")"
USER_="$(tenant_get infra.ssh.bootstrap_user root)"
STORAGE="$(provider_storage)"
DATA_GB="$(tenant_get volumes.data_size_gb)"; BACKUP_GB="$(tenant_get volumes.backup_size_gb)"
NEED_GB=$(( DATA_GB + BACKUP_GB + 20 ))
cat <<PLAN
Provider        : $(provider_conf title) - no API; server ordered by hand ($(tenant_get infra.ssh.panel_url "provider panel"))
Server          : $(tenant_get tenant.hostname)  $IP4 ${IP6:-(no IPv6)}  probe as $USER_ over SSH (read-only)
Storage         : $STORAGE: LUKS containers pddata ${DATA_GB} GB + pdbackup ${BACKUP_GB} GB on the root disk (D-147)
                  root filesystem needs >= ${NEED_GB} GB free
Firewall        : host nftables only (infra/server/host-firewall.nft); no provider firewall
Backups         : the off-site Backblaze B2 copy is the real backup on one disk (plan 01, D-147)
PLAN
# shellcheck disable=SC2016  # runs on the server: expands there, not here
PROBE='set -e; . /etc/os-release; echo "os=$ID $VERSION_ID"; echo "free_gb=$(df -BG --output=avail / | tail -1 | tr -dc 0-9)"; echo "disks=$(lsblk -dno NAME,SIZE,TYPE | awk '\''$3=="disk"{printf "%s:%s ", $1, $2}'\'')"; echo "v4=$(ip -4 -o addr show scope global | awk '\''{print $4}'\'' | cut -d/ -f1 | tr "\n" " ")"; echo "v6=$(ip -6 -o addr show scope global | awk '\''{print $4}'\'' | cut -d/ -f1 | tr "\n" " ")"'
if (( PD_DRY_RUN )); then
  echo "[dry-run] ssh -o BatchMode=yes $USER_@$IP4 '<read-only probe: os-release, df /, lsblk, ip addr>'"
  exit 0
fi
out="$(ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new "$USER_@$IP4" "$PROBE")" \
  || pd_die "SSH to $USER_@$IP4 failed (key installed? firewall? see infra/providers/ssh/README.md)"
printf '%s\n' "$out"
os="$(sed -n 's/^os=//p' <<<"$out")"; free="$(sed -n 's/^free_gb=//p' <<<"$out")"
v4="$(sed -n 's/^v4=//p' <<<"$out")"; v6="$(sed -n 's/^v6=//p' <<<"$out")"
rc=0
[[ "$os" == "ubuntu 24.04" ]] || { pd_warn "OS is '$os', PD is built for Ubuntu 24.04: reinstall from the provider panel"; rc=1; }
(( ${free:-0} >= NEED_GB )) || { pd_warn "only ${free:-?} GB free on /, need $NEED_GB GB for the containers + OS"; rc=1; }
[[ " $v4 " == *" $IP4 "* ]] || { pd_warn "$IP4 ([infra.ssh] ipv4) is not configured on the box (has: $v4)"; rc=1; }
if [[ -n "$IP6" && " $v6 " != *" $IP6 "* ]]; then pd_warn "$IP6 ([infra.ssh] ipv6) is not configured on the box (has: ${v6:-none}); configure netplan per the provider's guide"; rc=1; fi
(( rc == 0 )) || pd_die "probe found problems (above); fix them before infra/server/bootstrap-existing.sh"
echo "probe OK. Next: infra/server/bootstrap-existing.sh, then DNS (cloudflare-dns.py apply --from-provider)."
echo "STATE.md: | $(date +%F) | 01 | §2 server (ssh adapter) | done | $(tenant_get tenant.hostname) $IP4 / ${IP6:--}; $os; ${free} GB free; storage $STORAGE |"
