#!/usr/bin/env bash
# infra/luks/grow-volume.sh - plan 01 Growing a volume (online).
#
# Before running: grow the volume at OVHcloud (build machine:
#   infra/volume-extend.sh --volume data --size <GB> --confirm-purchase
# or the Control Panel). Then on the server:
#   sudo grow-volume.sh --volume data      (or backup)
# Steps, each skipped when nothing is left to do:
#   1. rescan the device so the kernel sees the new size (SCSI rescan; virtio-blk resizes itself);
#      root-container: extend the file, refresh the loop device
#   2. cryptsetup resize <mapper> --key-file <keyfile>   (grows the LUKS mapping)
#   3. resize2fs /dev/mapper/<mapper>                    (ext4 grows online)
#   4. prints the STATE.md line
# Never shrinks. Refuses if the mapper is not open on the expected by-id device.
#
# Flags: --volume data|backup (required), --size GB (root-container only), --dry-run, --tenant PATH, -h
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/ops-common.sh
source "$HERE/../lib/ops-common.sh"
# shellcheck source=luks-common.sh
source "$HERE/luks-common.sh"
usage() { ops_usage "${BASH_SOURCE[0]}"; }

ops_init grow-volume "$@"
set -- "${OPS_ARGS[@]+"${OPS_ARGS[@]}"}"
ROLE="" SIZE_GB=""
while (($#)); do
  case "$1" in
    --volume) ROLE="${2:-}"; shift ;;
    --size) SIZE_GB="${2:-}"; shift ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done
[[ "$ROLE" == data || "$ROLE" == backup ]] || die "--volume data|backup is required"

require_root
require_cmd cryptsetup resize2fs blockdev dumpe2fs findmnt
luks_load_volumes

dev="$(luks_dev "$ROLE")"; mapper="$(luks_mapper "$ROLE")"; key="$(luks_key "$ROLE")"; mp="$(luks_mount "$ROLE")"
luks_check_dev_path "$dev" "$(luks_vol_id "$ROLE")"
CONTAINER=0
[[ "$PD_STORAGE_MODE" == root-container ]] && CONTAINER=1
if (( CONTAINER )); then
  [[ "$SIZE_GB" =~ ^[0-9]+$ ]] || die "root-container storage: --size <GB> (the new total size) is required"
elif [[ -n "$SIZE_GB" ]]; then
  die "--size is only for root-container storage; grow the provider volume with infra/volume-extend.sh first"
fi

if is_dry && [[ ! -e "$dev" ]]; then
  if (( CONTAINER )); then
    run fallocate -l "${SIZE_GB}G" "$dev"
    run losetup -c "<loop device of $dev>"
  else
    run sh -c "echo 1 > /sys/class/block/<sdX>/device/rescan   (SCSI only)"
  fi
  run cryptsetup resize "$mapper" --key-file "$key"
  run resize2fs "/dev/mapper/$mapper"
  exit 0
fi

real="$(readlink -f "$dev")"
luks_mapper_active "$mapper" || die "/dev/mapper/$mapper is not open"
luks_mapper_backed_by "$mapper" "$dev" || die "/dev/mapper/$mapper is not backed by $real"
[[ "$(findmnt -no SOURCE "$mp" || true)" == "/dev/mapper/$mapper" ]] || die "$mp is not mounted from /dev/mapper/$mapper"

# 1. rescan (harmless when the size is already current). virtio-blk has no rescan file: the kernel
#    picks up an online extend by itself. root-container: grow the file, then refresh the loop device.
if (( CONTAINER )); then
  loopdev="$(luks_mapper_backing "$mapper")"
  cur=$(stat -c %s "$real"); want=$(( SIZE_GB * 1024 * 1024 * 1024 ))
  (( want >= cur )) || die "$real is $(( cur / 1024 / 1024 / 1024 )) GB; containers never shrink"
  if (( want > cur )); then
    free_gb="$(df -BG --output=avail / | tail -1 | tr -dc 0-9)"
    add_gb=$(( (want - cur) / 1024 / 1024 / 1024 ))
    (( free_gb - add_gb >= 15 )) || die "growing by ${add_gb} GB would leave less than 15 GB free on / (${free_gb} GB free)"
    run fallocate -l "${SIZE_GB}G" "$real"
  else
    log "$real is already ${SIZE_GB} GB"
  fi
  run losetup -c "$loopdev"
  real="$loopdev"     # the size checks below read the loop device
elif [[ -e "/sys/class/block/$(basename "$real")/device/rescan" ]]; then
  run sh -c "echo 1 > /sys/class/block/$(basename "$real")/device/rescan"
else
  log "no SCSI rescan file for $(basename "$real") (virtio-blk): size is refreshed by the kernel"
fi

dev_bytes="$(blockdev --getsize64 "$real")"
offset_sectors="$(cryptsetup status "$mapper" | awk '$1=="offset:"{print $2}')"
map_bytes="$(blockdev --getsize64 "/dev/mapper/$mapper")"
avail=$(( dev_bytes - offset_sectors * 512 ))
log "device $dev_bytes bytes, LUKS data area $avail, mapper $map_bytes"

# 2. LUKS mapping
if (( map_bytes < avail )); then
  run cryptsetup resize "$mapper" --key-file "$key"
  is_dry || map_bytes="$(blockdev --getsize64 "/dev/mapper/$mapper")"
else
  log "LUKS mapping already uses the whole device"
fi

# 3. Filesystem
bc="$(dumpe2fs -h "/dev/mapper/$mapper" 2>/dev/null | awk -F: '/^Block count/{gsub(/ /,"",$2);print $2}')"
bs="$(dumpe2fs -h "/dev/mapper/$mapper" 2>/dev/null | awk -F: '/^Block size/{gsub(/ /,"",$2);print $2}')"
fs_bytes=$(( bc * bs ))
if (( fs_bytes + bs <= map_bytes )) || is_dry; then
  run resize2fs "/dev/mapper/$mapper"
else
  log "filesystem already fills the mapping ($fs_bytes bytes)"
fi

gb=$(( dev_bytes / 1024 / 1024 / 1024 ))
echo "STATE.md: | $(date -u +%F) | 01 | 6.6 Grow $(luks_tenant_name "$ROLE") | done | now ${gb} GB; df: $(df -h --output=size "$mp" | tail -1 | tr -d ' ') |"
echo "Also update [volumes] ${ROLE}_size_gb in config/tenant.toml to $gb."
