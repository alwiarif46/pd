#!/usr/bin/env bash
# infra/luks/configure-boot.sh - plan 01 (auto-unlock, mount, Docker gate).
#
# Boot sequence this script sets up (details and failure analysis in README.md):
#   systemd-cryptsetup@pddata/pdbackup   (crypttab: keyfile, nofail, headless, 60s timeout)
#     -> mnt-pddata.mount / mnt-pdbackup.mount   (fstab: nofail, 60s device timeout)
#       -> docker.service   (drop-in: RequiresMountsFor=/mnt/pddata /mnt/pdbackup)
#   A missing or locked volume never blocks boot (SSH, tailscaled and the provider
#   VNC console keep working) but Docker cannot start, so no compose service runs with
#   restart=always against an empty directory. The mount points themselves are
#   chattr +i on the root disk, so even a container started by hand cannot write
#   user data there.
#
# Steps (each detected and skipped when already done):
#   1. /etc/crypttab  - managed lines for pddata / pdbackup (other lines untouched)
#   2. /etc/fstab     - managed lines, options exactly as plan 01
#   3. mount points   - created and made immutable ON THE ROOT DISK. When a volume is
#                       already mounted, the flag is set through a private bind of /
#                       so the mounted filesystem's root is never touched. Refuses if
#                       the directory underneath is not empty (data on the root disk).
#   4. /etc/systemd/system/docker.service.d/10-require-volumes.conf
#   5. daemon-reload, unlock + mount now
#   6. /mnt/pddata root  -> root 755; postgres/ and redis/ (0700 root: the postgres and redis images chown them on
#                           first start), files/ -> 1000:1000 0750 (the api and worker containers run as uid 1000)
#      /mnt/pdbackup     -> root 700; /mnt/pdbackup/borg -> root 700 (the Borg repository of ops/backup, infra/scripts/backup.sh)
#
# Flags: --dry-run, --tenant PATH, -h
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/ops-common.sh
source "$HERE/../lib/ops-common.sh"
# shellcheck source=luks-common.sh
source "$HERE/luks-common.sh"
usage() { ops_usage "${BASH_SOURCE[0]}"; }

ops_init configure-boot "$@"
(( ${#OPS_ARGS[@]} == 0 )) || die "unknown argument: ${OPS_ARGS[0]}"
require_root
require_cmd cryptsetup findmnt chattr lsattr systemctl
pd_find_python
luks_load_volumes

CRYPTTAB="${CRYPTTAB:-/etc/crypttab}"
FSTAB="${FSTAB:-/etc/fstab}"
DROPIN=/etc/systemd/system/docker.service.d/10-require-volumes.conf
CRYPT_OPTS="luks,discard,nofail,headless=true,x-systemd.device-timeout=60s"
FSTAB_OPTS="defaults,noatime,nodev,nosuid,noexec,nofail,x-systemd.device-timeout=60"

# --- pre-checks: volumes must already be LUKS with our keyfiles -------------------
for role in data backup; do
  dev="$(luks_dev "$role")"
  luks_check_dev_path "$dev" "$(luks_vol_id "$role")"
  if [[ -e "$dev" ]]; then
    cryptsetup isLuks "$dev" || die "$dev is not LUKS. Run format-volumes.sh first."
    [[ -r "$(luks_key "$role")" ]] || die "keyfile $(luks_key "$role") missing"
  elif ! is_dry; then
    die "$dev not present"
  fi
done

# --- managed-line editor for crypttab / fstab ----------------------------------------
# managed_edit FILE KEYCOL LINE...  -> prints the new file: drops lines whose column
# KEYCOL equals the key of a managed line, appends the managed lines. Refuses when
# another line references the same device or mount point.
managed_edit() {
  pd_find_python
  "$PD_PY" - "$@" <<'PY'
import sys
path, keycol, lines = sys.argv[1], int(sys.argv[2]), sys.argv[3:]
marker = "# pd: managed by infra/luks/configure-boot.sh (plan 01)"
try:
    cur = open(path, encoding="utf-8").read().splitlines()
except FileNotFoundError:
    cur = []
want = {l.split()[keycol] for l in lines}
devs = {l.split()[1 - keycol] for l in lines}
out = []
for l in cur:
    f = l.split()
    if l == marker:
        continue
    if not f or f[0].startswith("#"):
        out.append(l); continue
    if len(f) > keycol and f[keycol] in want:
        continue
    if len(f) > 1 and f[1 - keycol] in devs:
        sys.exit(f"{path}: unmanaged line already uses {f[1 - keycol]}: {l}")
    out.append(l)
while out and not out[-1].strip():
    out.pop()
if out:
    out.append("")
out += [marker] + lines
sys.stdout.buffer.write(("\n".join(out) + "\n").encode("utf-8"))
PY
}

# fstab safety: every line the old file had (other than ours) must survive the edit,
# so a bug here can never drop the root filesystem entry.
check_kept() {
  local old="$1" new="$2" l
  [[ -f "$old" ]] || return 0
  while IFS= read -r l; do
    [[ -z "${l// /}" || "$l" == "# pd: managed"* ]] && continue
    case "$l" in *" /mnt/pddata "*|*" /mnt/pdbackup "*|pddata\ *|pdbackup\ *) continue ;; esac
    grep -qxF -- "$l" "$new" || die "edit of $old would drop the line: $l"
  done <"$old"
}

D_DEV="$(luks_dev data)"; B_DEV="$(luks_dev backup)"
NEW_CT="$(mktemp)"; NEW_FS="$(mktemp)"
managed_edit "$(pd_native_path "$CRYPTTAB")" 0 \
  "pddata   $D_DEV  $(luks_key data)  $CRYPT_OPTS" \
  "pdbackup $B_DEV  $(luks_key backup)  $CRYPT_OPTS" >"$NEW_CT" || die "crypttab edit failed"
managed_edit "$(pd_native_path "$FSTAB")" 1 \
  "/dev/mapper/pddata    /mnt/pddata    ext4  $FSTAB_OPTS  0 2" \
  "/dev/mapper/pdbackup  /mnt/pdbackup  ext4  $FSTAB_OPTS  0 2" >"$NEW_FS" || die "fstab edit failed"
check_kept "$CRYPTTAB" "$NEW_CT"
check_kept "$FSTAB" "$NEW_FS"
ops_install_file "$CRYPTTAB" 0644 root:root <"$NEW_CT"
ops_install_file "$FSTAB" 0644 root:root <"$NEW_FS"
rm -f "$NEW_CT" "$NEW_FS"

is_mp() { mountpoint -q "$1" 2>/dev/null; }

# --- immutable mount points on the root disk --------------------------------------
ROOTVIEW=""   # read-only bind of /
ROOTRW=""     # temporary writable bind of / (chattr +i only)
cleanup() {
  if [[ -n "$ROOTRW" ]]; then umount "$ROOTRW" 2>/dev/null || true; rmdir "$ROOTRW" 2>/dev/null || true; fi
  if [[ -n "$ROOTVIEW" ]]; then umount "$ROOTVIEW" 2>/dev/null || true; rmdir "$ROOTVIEW" 2>/dev/null || true; fi
  return 0
}
trap cleanup EXIT

# A read-only, non-recursive bind of / shows the root-disk directories that sit under
# the volume mounts. Created in this shell (not a subshell) so the EXIT trap removes it.
ensure_rootview() {
  [[ -n "$ROOTVIEW" ]] && return 0
  ROOTVIEW="$(mktemp -d /run/pd-rootview.XXXXXX)"
  mount --bind / "$ROOTVIEW"
  mount --make-private "$ROOTVIEW"   # no mount/umount events propagate to or from the real tree
  mount -o remount,bind,ro "$ROOTVIEW" 2>/dev/null || true
}

for role in data backup; do
  mp="$(luks_mount "$role")"
  if [[ ! -d "$mp" ]]; then
    run install -d -m 0755 -o root -g root "$mp"
    is_dry && { run chattr +i "$mp"; continue; }
  fi
  if is_dry && is_mp "$mp"; then
    log "$mp is mounted; a real run checks/sets +i through a private bind of /"
    continue
  fi
  if is_mp "$mp"; then ensure_rootview; u="$ROOTVIEW$mp"; else u="$mp"; fi
  if lsattr -d "$u" 2>/dev/null | awk '{print $1}' | grep -q i; then
    log "immutable already: $mp (on root disk)"
    continue
  fi
  if [[ -n "$(ls -A "$u" 2>/dev/null)" ]]; then
    die "$mp on the root disk is not empty ($(ls -A "$u" | head -5 | tr '\n' ' ')). Something wrote there while unmounted. Investigate before continuing."
  fi
  if [[ "$u" != "$mp" ]]; then
    # chattr needs a writable view; use a separate rw bind just for this.
    ROOTRW="$(mktemp -d /run/pd-rootrw.XXXXXX)"
    run mount --bind / "$ROOTRW"
    run mount --make-private "$ROOTRW"
    run chattr +i "$ROOTRW$mp"
    run umount "$ROOTRW"; rmdir "$ROOTRW"; ROOTRW=""   # (the EXIT trap does the same if chattr fails)
  else
    run chattr +i "$mp"
  fi
  log "set immutable: $mp (root-disk directory)"
done

# --- Docker gate ---------------------------------------------------------------------
ops_install_file "$DROPIN" 0644 root:root <<'EOF'
# Managed by infra/luks/configure-boot.sh (plan 01).
# Docker (and so every compose service with restart: unless-stopped) starts only when both
# encrypted volumes are mounted. Requires= also stops Docker if a volume is unmounted.
[Unit]
RequiresMountsFor=/mnt/pddata /mnt/pdbackup
EOF

run systemctl daemon-reload

# --- unlock + mount now ---------------------------------------------------------------
for role in data backup; do
  mapper="$(luks_mapper "$role")"; mp="$(luks_mount "$role")"
  if ! luks_mapper_active "$mapper"; then
    run systemctl start "systemd-cryptsetup@$mapper.service"
  fi
  if ! is_mp "$mp"; then
    run systemctl start "$(systemd-escape --path --suffix=mount "$mp" 2>/dev/null || echo "${mp#/}" | tr / - | sed 's/$/.mount/')"
  fi
  if ! is_dry; then
    src="$(findmnt -no SOURCE "$mp" || true)"
    [[ "$src" == "/dev/mapper/$mapper" ]] || die "$mp is mounted from '$src', expected /dev/mapper/$mapper"
  fi
done

# --- ownership (non-recursive; plan 01: data on /mnt/pddata, Borg on /mnt/pdbackup) ----
set_owner_mode() {
  local p="$1" own="$2" mode="$3"
  if [[ -d "$p" ]] && [[ "$(stat -c %u:%g "$p")" == "$own" ]] && [[ "$(stat -c %a "$p")" == "$mode" ]]; then
    log "ok: $p $own $mode"; return 0
  fi
  run chown "$own" "$p"
  run chmod "$mode" "$p"
}
set_owner_mode /mnt/pddata 0:0 755
# Compose bind mounts (infra/docker-compose.yml): postgres and redis directories are chowned by their images on
# first start; files/ belongs to uid 1000, the user the api and worker containers run as.
for d in postgres redis; do
  [[ -d "/mnt/pddata/$d" ]] || run install -d -m 0700 -o root -g root "/mnt/pddata/$d"
done
[[ -d /mnt/pddata/files ]] || run install -d -m 0750 -o 1000 -g 1000 /mnt/pddata/files
set_owner_mode /mnt/pdbackup 0:0 700
[[ -d /mnt/pdbackup/borg ]] || run install -d -m 0700 -o root -g root /mnt/pdbackup/borg

log "Docker gate: $(systemctl show docker.service -p RequiresMountsFor 2>/dev/null || echo 'docker not installed yet')"
log "Reboot test (plan 01): sudo reboot; then findmnt /mnt/pddata /mnt/pdbackup; systemctl status docker"
log "Next: infra/scripts/deploy.sh (compose data under /mnt/pddata), infra/scripts/backup.sh --init (Borg repository /mnt/pdbackup/borg)"
