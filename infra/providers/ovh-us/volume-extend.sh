#!/usr/bin/env bash
# infra/providers/ovh-us/volume-extend.sh
# Implements: docs/plans/01-infrastructure.md section 6.6 step 1 (grow a Block Storage volume) on OVHcloud
# US Public Cloud (Drive D-134). Runs on the build machine. Billable: a bigger volume costs more per
# hour, so a real run needs --confirm-purchase. Never shrinks (OpenStack cannot shrink a volume).
#
# Online first: Cinder extends an attached ("in-use") volume from volume API microversion 3.42 when
# the backend supports it (*verify* on OVHcloud US at the first grow). If the API refuses, this script
# stops and prints the short offline procedure (maintenance window: Docker stopped, volume closed,
# detached, extended, re-attached) - it never detaches a production volume by itself (00-README
# section 9 rule 6). After the extend, on the server: sudo infra/luks/grow-volume.sh --volume <role>.
# OVH applies the new IOPS/throughput of a high-speed-gen2 volume after a detach + re-attach; that can
# wait for the next maintenance window.
#
# Usage:
#   volume-extend.sh --volume data|backup --size GB --dry-run
#   volume-extend.sh --volume data|backup --size GB --confirm-purchase
# Common flags: --tenant PATH  --secrets PATH  -h
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../lib/tenant.sh
. "$SCRIPT_DIR/../../lib/tenant.sh"
# shellcheck source=../../lib/openstack.sh
. "$SCRIPT_DIR/../../lib/openstack.sh"

usage() {
  sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
}

ROLE="" SIZE="" CONFIRM=0
pd_parse_args "$@"
set -- ${PD_REST[@]+"${PD_REST[@]}"}
while (( $# )); do
  case "$1" in
    --volume) ROLE="${2:-}"; shift ;;
    --size) SIZE="${2:-}"; shift ;;
    --confirm-purchase) CONFIRM=1 ;;
    *) pd_die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done
[[ "$ROLE" == data || "$ROLE" == backup ]] || pd_die "--volume data|backup is required"
[[ "$SIZE" =~ ^[1-9][0-9]{0,4}$ ]] || pd_die "--size GB (a whole number) is required"
(( PD_DRY_RUN || CONFIRM )) || pd_die "refusing to grow a billable volume without --confirm-purchase (preview with --dry-run)"

os_provider_check
NAME="$(tenant_get "volumes.${ROLE}_name")"
load_secrets
os_env
os_check_project

if (( PD_DRY_RUN )); then
  echo "[dry-run] would read the size of $NAME and refuse unless $SIZE GB is larger"
else
  cur="$(openstack volume show "$NAME" -f value -c size | tr -d '\r')"
  [[ "$cur" =~ ^[0-9]+$ ]] || pd_die "cannot read the size of volume $NAME"
  if (( SIZE <= cur )); then
    echo "volume $NAME is already $cur GB (asked for $SIZE GB): nothing to do (volumes never shrink)"
    exit 0
  fi
  echo "volume $NAME: $cur GB -> $SIZE GB"
fi
if ! run openstack --os-volume-api-version 3.42 volume set --size "$SIZE" "$NAME"; then
  cat >&2 <<EOT
The online extend was refused (OVH backend or API version). Offline procedure, in a maintenance
window, one volume at a time (plan 01):
  server:  sudo systemctl stop docker docker.socket
           sudo umount /mnt/pd$ROLE  &&  sudo cryptsetup close pd$ROLE
  laptop:  openstack server unlock <hostname>
           openstack server remove volume <hostname> $NAME
           openstack volume set --size $SIZE $NAME
           openstack server add volume <hostname> $NAME
           openstack server lock <hostname>                (never leave it unlocked)
  server:  sudo infra/luks/identify-volumes.sh            (the by-id link may be new: compare, never guess)
           sudo cryptsetup open <by-id path> pd$ROLE --key-file /etc/pd/luks/pd$ROLE.key
           sudo mount /mnt/pd$ROLE && sudo infra/luks/grow-volume.sh --volume $ROLE
           sudo systemctl start docker
EOT
  exit 1
fi
echo "Next, on the server: sudo ~/pd/infra/luks/grow-volume.sh --volume $ROLE"
echo "Then set [volumes] ${ROLE}_size_gb = $SIZE in config/tenant.toml."
