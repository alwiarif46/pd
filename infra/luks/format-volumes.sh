#!/usr/bin/env bash
# infra/luks/format-volumes.sh - plan 01 Format and open.
#
# DESTRUCTIVE (CLAUDE.md conventions rule 6: ask Amaan before luksFormat).
# For each volume (data -> pddata, backup -> pdbackup):
#   1. luksFormat --type luks2 --pbkdf argon2id with the keyfile from create-keyfiles.sh
#   2. luksAddKey: prompts for the recovery passphrase (second keyslot)
#   3. cryptsetup open
#   4. mkfs.ext4 -L <mapper> -m 1
#   5. luksHeaderBackup to /root/<mapper>.luksheader, then prints the copy-off steps.
#      The backup is RE-TAKEN (old file moved aside, never deleted) whenever its keyslot count
#      differs from the live header, so it always includes the recovery-passphrase slot.
#
# Guards (any failure stops the script before anything is written):
#   - a real run needs a terminal (the recovery passphrase is typed into luksAddKey); with no TTY
#     and a volume that still lacks its passphrase slot the script dies BEFORE any luksFormat
#   - device comes from /etc/pd/volumes.env (identify-volumes.sh), must be the
#     /dev/disk/by-id link named after the volume id, resolve to a block device, not mounted, no holders
#     (root-container: exactly /var/lib/pd/disks/<mapper>.img, root-owned 0600, not loop-attached)
#   - luksFormat and mkfs run only for volumes confirmed on the command line with
#       --i-understand-this-destroys <volume-id>
#     (the volume's own id - OpenStack UUID, Hetzner number, or container-pddata / container-pdbackup for
#     root-container storage, D-147 - so a typo cannot hit the other volume)
#   - luksFormat refuses if the device has ANY signature (blkid -p / wipefs) or if
#     its first 64 MiB are not all zero (a new, blank OVHcloud Block Storage volume
#     reads as zeros; *verify* on the first volume - if not, the script stops and a human decides)
#   - mkfs refuses if the opened mapper already carries any signature
#   - an existing LUKS header is never reformatted: the step is skipped and the
#     keyfile is tested against it instead (wrong key = wrong volume = stop)
# Safe to re-run: every finished step is detected and skipped.
#
# Usage:
#   sudo format-volumes.sh --dry-run
#   sudo format-volumes.sh --i-understand-this-destroys <data-id> --i-understand-this-destroys <backup-id>
#   sudo format-volumes.sh --only data --i-understand-this-destroys <data-id>
# Flags: --only data|backup, --dry-run, --tenant PATH, -h
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/ops-common.sh
source "$HERE/../lib/ops-common.sh"
# shellcheck source=luks-common.sh
source "$HERE/luks-common.sh"
usage() { ops_usage "${BASH_SOURCE[0]}"; }

ops_init format-volumes "$@"
set -- "${OPS_ARGS[@]+"${OPS_ARGS[@]}"}"
ROLES=(data backup)
CONFIRMED=()
while (($#)); do
  case "$1" in
    --i-understand-this-destroys) CONFIRMED+=("${2:?volume id required}"); shift ;;
    --only) case "${2:-}" in data|backup) ROLES=("$2") ;; *) die "--only data|backup" ;; esac; shift ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done

require_root
require_cmd cryptsetup blkid wipefs lsblk mkfs.ext4 cmp
luks_load_volumes

confirmed() { local c; for c in "${CONFIRMED[@]+"${CONFIRMED[@]}"}"; do [[ "$c" == "$1" ]] && return 0; done; return 1; }
NEED_CONFIRM=0

# Refuse unless the raw device is provably blank.
assert_blank() {
  local dev="$1" sig
  sig="$(blkid -p -o export "$dev" 2>/dev/null || true)"
  [[ -z "$sig" ]] || die "$dev already has a signature, refusing to format:
$sig"
  sig="$(wipefs --no-act "$dev" 2>/dev/null | tail -n +2 || true)"
  [[ -z "$sig" ]] || die "$dev: wipefs reports signatures, refusing to format:
$sig"
  if ! cmp -s -n $((64 * 1024 * 1024)) "$dev" /dev/zero; then
    die "$dev: first 64 MiB are not all zero. Not a fresh volume; refusing to format."
  fi
}

keyslot_count() { cryptsetup luksDump "$1" | grep -cE '^[[:space:]]+[0-9]+: luks2$' || true; }

# Die before anything is written if the passphrase slot cannot be added (no terminal).
preflight_tty() {
  is_dry && return 0
  [[ -t 0 ]] && return 0
  local role dev
  for role in "${ROLES[@]}"; do
    dev="$(luks_dev "$role")"
    [[ -e "$dev" ]] || continue
    if ! cryptsetup isLuks "$dev" 2>/dev/null || (( $(keyslot_count "$dev") < 2 )); then
      die "no terminal on stdin and $role volume ($dev) still needs its recovery-passphrase keyslot. luksFormat/luksAddKey need an interactive session: run this over an interactive ssh (ssh -t) so nothing is formatted without the passphrase being set."
    fi
  done
}

do_volume() {
  local role="$1" dev id mapper key real
  dev="$(luks_dev "$role")"; id="$(luks_vol_id "$role")"
  mapper="$(luks_mapper "$role")"; key="$(luks_key "$role")"
  log "== $role volume: $dev -> /dev/mapper/$mapper"
  luks_check_dev_path "$dev" "$id"

  if is_dry && [[ ! -e "$dev" ]]; then
    printf '+ (blank check) blkid -p, wipefs --no-act, first 64 MiB == zero on %s\n' "$dev"
    run cryptsetup luksFormat --batch-mode --type luks2 --pbkdf argon2id --key-file "$key" "$dev"
    run cryptsetup luksAddKey --pbkdf argon2id --key-file "$key" "$dev"
    run cryptsetup open --type luks2 --key-file "$key" "$dev" "$mapper"
    run mkfs.ext4 -L "$mapper" -m 1 "/dev/mapper/$mapper"
    run cryptsetup luksHeaderBackup "$dev" --header-backup-file "/root/$mapper.luksheader"
    return 0
  fi

  [[ -e "$dev" ]] || die "$dev not present (volume attached? container created by identify-volumes.sh --root-container?)"
  is_dry || [[ -r "$key" ]] || die "keyfile $key missing: run create-keyfiles.sh first"
  real="$(readlink -f "$dev")"

  # 1. LUKS format
  if cryptsetup isLuks "$dev" 2>/dev/null; then
    log "already LUKS: $dev (not reformatting)"
    if [[ -r "$key" ]]; then
      cryptsetup open --test-passphrase --key-file "$key" "$dev" \
        || die "$key does NOT unlock $dev. Wrong keyfile or wrong volume. Stop and investigate."
      log "keyfile $key unlocks $dev"
    fi
  else
    if luks_dev_in_use "$dev"; then die "$dev ($real) is mounted or held by another device"; fi
    assert_blank "$dev"
    if ! confirmed "$id"; then
      warn "$role volume $id is blank and would be LUKS-formatted. Re-run with --i-understand-this-destroys $id"
      NEED_CONFIRM=1; return 0
    fi
    run cryptsetup luksFormat --batch-mode --type luks2 --pbkdf argon2id --key-file "$key" "$dev"
  fi

  # 2. Recovery passphrase in a second keyslot
  local slots=0
  is_dry || slots="$(keyslot_count "$dev")"
  if (( slots >= 2 )); then
    log "$slots keyslots present on $dev (passphrase slot assumed present; verify in the password manager)"
  elif [[ -t 0 ]] || is_dry; then  # (no-TTY case already refused by preflight_tty)
    log "Adding the recovery passphrase for $mapper. Use a generated passphrase (6+ random words)"
    log "and save it in the password manager as 'LUKS $mapper passphrase' BEFORE pressing enter."
    run cryptsetup luksAddKey --pbkdf argon2id --key-file "$key" "$dev"
  else
    warn "no terminal: passphrase keyslot NOT added to $dev. Re-run this script interactively."
  fi

  # 3. Open
  if luks_mapper_active "$mapper"; then
    luks_mapper_backed_by "$mapper" "$dev" \
      || die "/dev/mapper/$mapper is open on $(luks_mapper_backing "$mapper"), not $real"
    log "already open: /dev/mapper/$mapper"
  else
    run cryptsetup open --type luks2 --key-file "$key" "$dev" "$mapper"
  fi

  # 4. Filesystem
  local fs label
  fs="$(blkid -p -s TYPE -o value "/dev/mapper/$mapper" 2>/dev/null || true)"
  label="$(blkid -p -s LABEL -o value "/dev/mapper/$mapper" 2>/dev/null || true)"
  if [[ "$fs" == ext4 && "$label" == "$mapper" ]]; then
    log "filesystem present: ext4 label $mapper"
  elif [[ -n "$fs" ]] && ! is_dry; then
    die "/dev/mapper/$mapper carries '$fs' (label '$label'), not ext4/$mapper. Refusing mkfs."
  elif ! confirmed "$id"; then
    warn "/dev/mapper/$mapper has no filesystem. Re-run with --i-understand-this-destroys $id to mkfs."
    NEED_CONFIRM=1; return 0
  else
    run mkfs.ext4 -L "$mapper" -m 1 "/dev/mapper/$mapper"
  fi

  # 5. Header backup. Re-taken when the keyslot count differs from the backup (e.g. the backup
  #    predates the passphrase slot); the old file is moved aside, never deleted or overwritten.
  local hdr="/root/$mapper.luksheader" live_slots="" bak_slots=""
  if [[ -e "$hdr" ]] && ! is_dry; then
    live_slots="$(keyslot_count "$dev")"
    bak_slots="$(keyslot_count "$hdr" 2>/dev/null || echo '?')"
  fi
  if [[ -e "$hdr" && "$live_slots" == "$bak_slots" ]]; then
    log "header backup exists: $hdr (keyslots: ${bak_slots:-unchanged})"
  else
    if [[ -e "$hdr" ]]; then
      warn "header backup $hdr has $bak_slots keyslot(s), the live header has $live_slots: taking a new backup, old one kept as $hdr.<timestamp>.old"
      run mv -- "$hdr" "$hdr.$(date +%Y%m%dT%H%M%S).old"
    fi
    run cryptsetup luksHeaderBackup "$dev" --header-backup-file "$hdr"
    run chmod 0400 "$hdr"
  fi
}

preflight_tty
for r in "${ROLES[@]}"; do do_volume "$r"; done

cat >&2 <<EOF

Header backups (plan 01): copy each /root/<mapper>.luksheader off the server into the
password manager as an attachment, over the admin network:
  server:  sudo install -m 0400 -o $(tenant_get server.admin_user 2>/dev/null || echo pdadmin) /root/pddata.luksheader /root/pdbackup.luksheader ~/
  laptop:  scp '<admin>@<server>:~/*.luksheader' .     (attach both, then delete the laptop copies)
  server:  sudo shred -u ~/pddata.luksheader ~/pdbackup.luksheader /root/pddata.luksheader /root/pdbackup.luksheader
A header backup plus the passphrase opens the volume: treat it like the passphrase.

Next: configure-boot.sh (crypttab, fstab, immutable mount points, Docker gate).
EOF

if (( NEED_CONFIRM )); then
  is_dry && { log "dry-run: a real run would stop here until the volume ids are confirmed"; exit 0; }
  die "stopped: some volumes need explicit confirmation (see warnings above)"
fi
