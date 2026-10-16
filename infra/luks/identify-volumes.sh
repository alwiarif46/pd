#!/usr/bin/env bash
# infra/luks/identify-volumes.sh - plan 01 Identify devices.
#
# Maps the two encrypted "volumes" (names from tenant.toml [volumes]) to a stable path, written to
# /etc/pd/volumes.env for the other LUKS scripts. Never /dev/sdX or /dev/vdX: letters can swap
# between boots, and formatting the wrong one is unrecoverable.
#
# Storage = volumes (provider block volumes; D-133, D-146):
#   Build machine:  identify-volumes.sh --from-provider        (alias: --from-openstack)
#       asks the [infra] provider adapter for the volume ids (infra/volume-ids.sh) and prints the exact
#       command to run on the server. ovh-us also prints size, type, attachment and protection.
#   Server (root):  identify-volumes.sh --data-id <id> --backup-id <id>
#       finds the /dev/disk/by-id link of each id (OpenStack UUID or numeric Hetzner id, see
#       luks-common.sh), verifies both resolve to block devices, are different, are not the root disk and
#       roughly match the tenant sizes; writes volumes.env. Refuses to change a volumes.env that differs.
#   Server, no ids: lists every whole-disk by-id link with its size, changes nothing.
#
# Storage = root-container (one disk only; D-147):
#   Server (root):  identify-volumes.sh --root-container
#       creates /var/lib/pd/disks (0700) and, when missing, one preallocated container per role
#       (<mapper>.img, root 0600, [volumes] sizes; fallocate reserves real blocks and reads back as
#       zeros), refusing when the root filesystem would keep less than 15 GB free; writes volumes.env with
#       the container paths. Never shrinks or replaces an existing container.
#
# Flags: --dry-run, --tenant PATH, --secrets PATH (--from-provider), -h
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/ops-common.sh
source "$HERE/../lib/ops-common.sh"
# shellcheck source=luks-common.sh
source "$HERE/luks-common.sh"

usage() { ops_usage "${BASH_SOURCE[0]}"; }

ops_init identify-volumes "$@"
set -- "${OPS_ARGS[@]+"${OPS_ARGS[@]}"}"

MODE=list DATA_ID="" BACKUP_ID=""
while (($#)); do
  case "$1" in
    --from-provider | --from-openstack) MODE=provider ;;
    --root-container) MODE=container ;;
    --data-id) DATA_ID="${2:?}"; shift; MODE=server ;;
    --backup-id) BACKUP_ID="${2:?}"; shift; MODE=server ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done

DATA_NAME="$(tget volumes.data_name)"
BACKUP_NAME="$(tget volumes.backup_name)"

write_volumes_env() {
  local content="$1"
  if [[ -f "$VOLUMES_ENV" ]] && ! diff -q <(printf '%s\n' "$content") "$VOLUMES_ENV" >/dev/null; then
    diff -u "$VOLUMES_ENV" <(printf '%s\n' "$content") >&2 || true
    die "$VOLUMES_ENV already exists with different values. Investigate before changing it (edit or remove it by hand)."
  fi
  printf '%s\n' "$content" | ops_install_file "$VOLUMES_ENV" 0600 root:root
}

provider_mode() {
  # shellcheck source=../lib/provider.sh
  source "$HERE/../lib/provider.sh"
  provider_tenant_args
  local p out role id
  p="$(provider_name)"
  [[ "$(provider_storage)" == volumes ]] || die "[infra] storage = root-container: run identify-volumes.sh --root-container on the server instead"
  out="$(bash "$HERE/../volume-ids.sh" ${PROVIDER_ARGS[@]+"${PROVIDER_ARGS[@]}"})" || die "infra/volume-ids.sh failed (provider $p)"
  local -A ids=()
  while read -r role id; do
    [[ "$role" == data || "$role" == backup ]] && ids[$role]="$id"
  done <<<"$out"
  printf 'data   %s = %s\nbackup %s = %s   (provider %s)\n' "$DATA_NAME" "${ids[data]:-?}" "$BACKUP_NAME" "${ids[backup]:-?}" "$p"
  if [[ "$p" == ovh-us ]] && ! is_dry; then ovh_details; fi
  if [[ -n "${ids[data]:-}" && -n "${ids[backup]:-}" ]]; then
    echo
    echo "Run on the server:"
    echo "  sudo infra/luks/identify-volumes.sh --data-id ${ids[data]} --backup-id ${ids[backup]}"
  fi
}

# OVHcloud extras: size, type, attachment and the pd-protected property of each volume.
ovh_details() {
  # shellcheck source=../lib/openstack.sh
  source "$HERE/../lib/openstack.sh"
  load_secrets
  os_env
  pd_find_python          # sets $PD_PY (python3 may be a Store stub on Windows)
  local role name json
  for role in data backup; do
    name="$(luks_tenant_name "$role")"
    json="$(openstack volume show "$name" -f json 2>/dev/null)" || { warn "openstack volume show $name failed"; continue; }
    "$PD_PY" - "$json" "$role" <<'PY'
import json, sys
v = json.loads(sys.argv[1])
att = v.get("attachments") or []
props = v.get("properties") or {}
print("%-6s name=%s id=%s size=%sGB type=%s status=%s attached_to=%s device=%s pd-protected=%s" % (
    sys.argv[2], v.get("name"), v.get("id"), v.get("size"), v.get("type"), v.get("status"),
    ",".join(a.get("server_id", "?") for a in att) or "-", ",".join(a.get("device", "?") for a in att) or "-",
    props.get("pd-protected", "-") if isinstance(props, dict) else props))
PY
  done
}

container_mode() {
  require_root
  [[ "$(tenant_get infra.storage "")" == root-container ]] \
    || die "[infra] storage is not root-container in tenant.toml (the tenant file decides the design; D-147)"
  require_cmd fallocate df stat
  [[ ! -L "$CONTAINER_DIR" ]] || die "$CONTAINER_DIR is a symlink; refusing (containers must live on the root disk itself)"
  local role f want_gb have_bytes need_gb=0 free_gb
  for role in data backup; do
    f="$(luks_container_path "$role")"; want_gb="$(luks_tenant_size "$role")"
    [[ -e "$f" || -L "$f" ]] || need_gb=$(( need_gb + want_gb ))
  done
  free_gb="$(df -BG --output=avail / | tail -1 | tr -dc 0-9)"
  if (( need_gb > 0 && free_gb - need_gb < 15 )); then
    die "the root filesystem has ${free_gb} GB free; creating ${need_gb} GB of containers would leave less than 15 GB for the OS, Docker and images. Lower the [volumes] sizes or use a bigger disk."
  fi
  run install -d -m 0700 -o root -g root "$CONTAINER_DIR"
  for role in data backup; do
    f="$(luks_container_path "$role")"; want_gb="$(luks_tenant_size "$role")"
    if [[ -e "$f" || -L "$f" ]]; then
      [[ -f "$f" && ! -L "$f" ]] || die "$f exists and is not a regular file (symlink?)"
      have_bytes="$(stat -c %s "$f")"
      (( have_bytes == want_gb * 1024 * 1024 * 1024 )) \
        || warn "$f is $have_bytes bytes; tenant.toml says ${want_gb} GB (grown? see grow-volume.sh --size)"
      log "$role: $f exists (kept)"
    else
      # Reserved now (no ENOSPC surprise under LUKS later), reads back as zeros (format-volumes.sh's
      # blank check). umask 077 so the file is never readable by others, even for a moment.
      run sh -c "umask 077 && fallocate -l ${want_gb}G '$f'"
      run chmod 0600 "$f"
      log "$role: created $f (${want_gb} GB)"
    fi
  done
  local content
  content="$(cat <<EOF
# Written by infra/luks/identify-volumes.sh --root-container (plan 01, D-147). Do not hand-edit.
# LUKS containers on the root disk: data=$DATA_NAME backup=$BACKUP_NAME
PD_STORAGE_MODE=root-container
PD_DATA_VOLUME_ID=container-pddata
PD_DATA_DEVICE=$(luks_container_path data)
PD_BACKUP_VOLUME_ID=container-pdbackup
PD_BACKUP_DEVICE=$(luks_container_path backup)
EOF
)"
  write_volumes_env "$content"
  echo
  echo "Lines for STATE.md (plan 01):"
  echo "| $(date -u +%F) | 01 | 6.1 Identify devices (root-container) | done | $(luks_container_path data) ($(luks_tenant_size data) GB), $(luks_container_path backup) ($(luks_tenant_size backup) GB) |"
  echo "Next: create-keyfiles.sh, then format-volumes.sh --i-understand-this-destroys container-pddata --i-understand-this-destroys container-pdbackup"
}

list_mode() {
  local l real
  shopt -s nullglob
  local links=("$BYID_DIR"/*)
  local shown=0
  for l in "${links[@]}"; do
    [[ "$l" == *-part[0-9]* ]] && continue
    case "$(basename "$l")" in virtio-* | scsi-*) ;; *) continue ;; esac   # scsi-0HC_Volume_* = Hetzner
    real="$(readlink -f "$l")"
    printf '%s -> %s  %s bytes\n' "$l" "$real" "$(blockdev --getsize64 "$l" 2>/dev/null || echo '?')"
    shown=1
  done
  (( shown )) || { warn "no virtio-*/scsi-* links in $BYID_DIR (volumes attached? root-container storage uses --root-container)"; return 0; }
  echo "The link name carries the volume id (OpenStack UUID or its first 20 characters; Hetzner number). Get the"
  echo "ids by name with --from-provider on the build machine; the root disk is one of the links above, never use it."
}

server_mode() {
  [[ -n "$DATA_ID" && -n "$BACKUP_ID" ]] || die "need both --data-id and --backup-id"
  [[ "$DATA_ID" != "$BACKUP_ID" ]] || die "data and backup ids are the same"
  require_root
  local role id dev real size want_gb root_src root_disk
  root_src="$(findmnt -no SOURCE / 2>/dev/null || true)"
  root_disk="$(lsblk -no PKNAME "$root_src" 2>/dev/null | head -1 || true)"
  local -A devs=()
  for role in data backup; do
    if [[ $role == data ]]; then id=$DATA_ID; else id=$BACKUP_ID; fi
    dev="$(luks_find_byid "$id")"
    luks_check_dev_path "$dev" "$id"
    devs[$role]="$dev"
    [[ -e "$dev" ]] || continue
    real="$(readlink -f "$dev")"
    [[ -n "$root_disk" && "$(basename "$real")" == "$root_disk" ]] && die "$dev resolves to the root disk"
    size="$(blockdev --getsize64 "$real")"
    want_gb="$(luks_tenant_size "$role")"
    if (( size != want_gb * 1024 * 1024 * 1024 )); then
      warn "$role volume $dev is $size bytes; tenant.toml says ${want_gb} GB. Check the id (or the volume was grown)."
    fi
    log "$role: $dev -> $real ($size bytes)"
  done
  [[ "$(readlink -f "${devs[data]}")" != "$(readlink -f "${devs[backup]}")" ]] || die "data and backup ids resolve to the same device"
  local content
  content="$(cat <<EOF
# Written by infra/luks/identify-volumes.sh (plan 01). Do not hand-edit.
# Provider block volumes ($(tenant_get infra.provider)): data=$DATA_NAME backup=$BACKUP_NAME
PD_STORAGE_MODE=volumes
PD_DATA_VOLUME_ID=$DATA_ID
PD_DATA_DEVICE=${devs[data]}
PD_BACKUP_VOLUME_ID=$BACKUP_ID
PD_BACKUP_DEVICE=${devs[backup]}
EOF
)"
  write_volumes_env "$content"
  echo
  echo "Lines for STATE.md (plan 01):"
  echo "| $(date -u +%F) | 01 | 6.1 Identify devices | done | $DATA_NAME = $DATA_ID (${devs[data]}) ; $BACKUP_NAME = $BACKUP_ID (${devs[backup]}) |"
}

case "$MODE" in
  provider)  provider_mode ;;
  container) container_mode ;;
  server)    server_mode ;;
  list)      list_mode ;;
esac
