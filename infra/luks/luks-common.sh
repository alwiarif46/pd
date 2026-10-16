# shellcheck shell=bash
# infra/luks/luks-common.sh - constants and helpers for the plan 01 LUKS scripts.
# Sourced by identify-volumes.sh, create-keyfiles.sh, format-volumes.sh,
# configure-boot.sh, grow-volume.sh. See README.md in this folder for the design.
#
# Names below are fixed constants (not operator-specific):
#   data volume   -> LUKS mapper pddata   -> /mnt/pddata
#   backup volume -> LUKS mapper pdbackup -> /mnt/pdbackup
# Volume names and sizes come from config/tenant.toml [volumes]. Volumes of the ovh-us adapter are OVHcloud Block
# Storage (OpenStack Cinder): the id is a UUID, and the kernel exposes the attachment as
# /dev/disk/by-id/<bus>-<serial> where the serial is the volume UUID (virtio-scsi:
# scsi-0QEMU_QEMU_HARDDISK_<uuid>) or its first 20 characters (virtio-blk: virtio-<uuid[:20]>).
# luks_find_byid accepts exactly those two shapes (*verify* the bus on the first OVH server with
# `ls -l /dev/disk/by-id/`; identify-volumes.sh lists every candidate).
#
# Storage modes (Drive D-146, D-147; volumes.env PD_STORAGE_MODE):
#   volumes         provider block volumes, found by id under /dev/disk/by-id:
#                   OpenStack (ovh-us) UUID  -> scsi-0QEMU_QEMU_HARDDISK_<uuid> | virtio-<uuid[:20]>
#                   Hetzner numeric id       -> scsi-0HC_Volume_<id>
#   root-container  one disk only (Contabo, generic ssh hosts, small test servers): each "volume" is a
#                   preallocated file on the root disk, $CONTAINER_DIR/<mapper>.img (root, 0600), with
#                   its own LUKS2 header and keyfile; cryptsetup and systemd-cryptsetup attach it through
#                   a loop device. Its id is "container-<mapper>".

LUKS_KEY_DIR="${PD_LUKS_KEY_DIR:-/etc/pd/luks}"   # override only for offline tests
VOLUMES_ENV="${PD_VOLUMES_ENV:-/etc/pd/volumes.env}"   # written by identify-volumes.sh; override only for offline tests
BYID_DIR="${PD_BYID_DIR:-/dev/disk/by-id}"   # override only for offline tests
UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
HCLOUD_ID_RE='^[0-9]{4,12}$'
CONTAINER_DIR="${PD_CONTAINER_DIR:-/var/lib/pd/disks}"   # override only for offline tests

# role -> mapper / mount point / keyfile
luks_mapper() { case "$1" in data) echo pddata ;; backup) echo pdbackup ;; *) die "unknown volume role: $1" ;; esac; }
luks_mount()  { echo "/mnt/$(luks_mapper "$1")"; }
luks_key()    { echo "$LUKS_KEY_DIR/$(luks_mapper "$1").key"; }
luks_tenant_name() { case "$1" in data) tget volumes.data_name ;; backup) tget volumes.backup_name ;; esac; }
luks_tenant_size() { case "$1" in data) tget volumes.data_size_gb ;; backup) tget volumes.backup_size_gb ;; esac; }

# Load /etc/pd/volumes.env. In dry-run on a machine without it, use
# placeholders so the plan can still be printed.
luks_load_volumes() {
  PD_STORAGE_MODE=volumes
  if [[ -r "$VOLUMES_ENV" ]]; then
    # shellcheck source=/dev/null
    source "$VOLUMES_ENV"
  elif is_dry && [[ "$(tenant_get infra.storage "")" == root-container ]]; then
    warn "$VOLUMES_ENV not found; using the root-container paths (dry-run only)"
    PD_STORAGE_MODE=root-container
    PD_DATA_VOLUME_ID=container-pddata PD_BACKUP_VOLUME_ID=container-pdbackup
    PD_DATA_DEVICE="$(luks_container_path data)" PD_BACKUP_DEVICE="$(luks_container_path backup)"
  elif is_dry; then
    warn "$VOLUMES_ENV not found; using placeholder ids (dry-run only)"
    PD_DATA_VOLUME_ID="${PD_DATA_VOLUME_ID:-<data-id>}"
    PD_BACKUP_VOLUME_ID="${PD_BACKUP_VOLUME_ID:-<backup-id>}"
    PD_DATA_DEVICE="$BYID_DIR/<by-id link of the data volume>"
    PD_BACKUP_DEVICE="$BYID_DIR/<by-id link of the backup volume>"
  else
    die "$VOLUMES_ENV not found. Run identify-volumes.sh --data-id <id> --backup-id <id> first."
  fi
  : "${PD_DATA_DEVICE:?} ${PD_BACKUP_DEVICE:?} ${PD_DATA_VOLUME_ID:?} ${PD_BACKUP_VOLUME_ID:?}"
  case "$PD_STORAGE_MODE" in volumes | root-container) ;; *) die "$VOLUMES_ENV: unknown PD_STORAGE_MODE '$PD_STORAGE_MODE'" ;; esac
}

luks_dev() { case "$1" in data) echo "$PD_DATA_DEVICE" ;; backup) echo "$PD_BACKUP_DEVICE" ;; esac; }
luks_vol_id() { case "$1" in data) echo "$PD_DATA_VOLUME_ID" ;; backup) echo "$PD_BACKUP_VOLUME_ID" ;; esac; }

# The by-id link names a volume id can have (see the header). Never /dev/sdX or /dev/vdX.
luks_byid_names() { # luks_byid_names ID -> candidate basenames, most specific first
  if [[ "$1" =~ $HCLOUD_ID_RE ]]; then
    printf '%s\n' "scsi-0HC_Volume_$1"
  else
    printf '%s\n' "scsi-0QEMU_QEMU_HARDDISK_$1" "virtio-${1:0:20}" "scsi-0QEMU_QEMU_HARDDISK_${1:0:20}"
  fi
}

luks_valid_volume_id() { [[ "$1" =~ $UUID_RE || "$1" =~ $HCLOUD_ID_RE ]]; }

# root-container ids and paths
luks_is_container_id() { [[ "$1" == container-pddata || "$1" == container-pdbackup ]]; }
luks_container_path() { echo "$CONTAINER_DIR/$(luks_mapper "$1").img"; }   # by role

# luks_find_byid UUID -> prints the one by-id link for that volume; dies on none or ambiguity.
luks_find_byid() {
  local id="$1" n found=() real=""
  luks_valid_volume_id "$id" || die "volume id must be an OpenStack volume UUID (lowercase) or a numeric Hetzner volume id: $id"
  while IFS= read -r n; do
    [[ -L "$BYID_DIR/$n" ]] && found+=("$BYID_DIR/$n")
  done < <(luks_byid_names "$id")
  ((${#found[@]})) || die "no $BYID_DIR link for volume $id (attached? run identify-volumes.sh with no ids to list candidates)"
  for n in "${found[@]}"; do
    if [[ -z "$real" ]]; then real="$(readlink -f "$n")"
    elif [[ "$(readlink -f "$n")" != "$real" ]]; then die "by-id links for $id point to different devices: ${found[*]}"; fi
  done
  printf '%s\n' "${found[0]}"
}

# Stable path check: a /dev/disk/by-id link whose name carries the volume UUID (or its 20-char
# prefix), resolving to a block device.
luks_check_dev_path() {
  local dev="$1" id="$2" n ok=0
  if luks_is_container_id "$id"; then
    # root-container: exactly $CONTAINER_DIR/<mapper>.img, a plain file (no symlink) owned by root, 0600
    [[ "$dev" == "$CONTAINER_DIR/${id#container-}.img" ]] || die "container path $dev does not belong to $id (expected $CONTAINER_DIR/${id#container-}.img)"
    is_dry && [[ ! -e "$dev" ]] && { warn "$dev not present (dry-run)"; return 0; }
    [[ -f "$dev" && ! -L "$dev" ]] || die "$dev is not a regular file"
    [[ "$(stat -c %u:%a "$dev")" == "0:600" ]] || die "$dev must be owned by root with mode 0600 (is $(stat -c %u:%a "$dev"))"
    return 0
  fi
  [[ "$dev" == "$BYID_DIR/"* ]] || die "device path $dev is not under $BYID_DIR"
  is_dry && [[ ! -e "$dev" ]] && { warn "$dev not present (dry-run)"; return 0; }
  luks_valid_volume_id "$id" || die "volume id must be an OpenStack volume UUID or a numeric Hetzner volume id: $id"
  while IFS= read -r n; do [[ "$dev" == "$BYID_DIR/$n" ]] && ok=1; done < <(luks_byid_names "$id")
  (( ok )) || die "device path $dev does not belong to volume id $id"
  [[ -L "$dev" ]] || die "$dev is not a by-id symlink"
  [[ -b "$(readlink -f "$dev")" ]] || die "$dev does not resolve to a block device"
}

# Is the given block device (or container file) or any of its children mounted / held?
luks_dev_in_use() {
  local real; real="$(readlink -f "$1")"
  if [[ -f "$real" ]]; then
    [[ -n "$(losetup -nO NAME -j "$real" 2>/dev/null)" ]]
    return
  fi
  [[ -n "$(lsblk -nro MOUNTPOINT "$real" 2>/dev/null | sed '/^$/d')" ]] && return 0
  [[ -n "$(ls -A "/sys/class/block/$(basename "$real")/holders" 2>/dev/null)" ]] && return 0
  return 1
}

luks_mapper_active() { [[ -e "/dev/mapper/$1" ]] && cryptsetup status "$1" >/dev/null 2>&1; }

# Backing device of an active mapper, as a resolved /dev/sdX path.
luks_mapper_backing() { cryptsetup status "$1" 2>/dev/null | awk '$1=="device:"{print $2}'; }

# luks_mapper_backed_by MAPPER DEV: true when the open mapper sits on DEV. For a container file the
# mapper sits on a loop device whose backing file must be DEV.
luks_mapper_backed_by() {
  local mapper="$1" real backing
  real="$(readlink -f "$2")"
  backing="$(luks_mapper_backing "$mapper")"
  [[ "$backing" == "$real" ]] && return 0
  if [[ "$backing" == /dev/loop* && -f "$real" ]]; then
    [[ "$(losetup -nO BACK-FILE "$backing" 2>/dev/null | sed 's/ *(deleted)$//')" == "$real" ]]
    return
  fi
  return 1
}
