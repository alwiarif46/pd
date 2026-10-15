#!/usr/bin/env bash
# infra/luks/create-keyfiles.sh - plan 01 Keyfiles.
#
# Creates /etc/pd/luks (0700) and one 64-byte random keyfile per volume:
#   /etc/pd/luks/pddata.key  /etc/pd/luks/pdbackup.key   (0400 root)
#
# Never overwrites an existing keyfile: a keyfile that already unlocks a volume is
# the only automatic way in; replacing it would make that volume unbootable.
# Existing files are checked (size 64, regular file) and only their mode is fixed.
# Creation uses dd conv=excl, so even a race cannot clobber a file.
#
# The keyfiles live on the root disk. That is why provider instance backups and snapshots stay off
# (plan 01): a root-disk backup would hold the keys next to the snapshots.
# The recovery path if the root disk is lost is the passphrase keyslot that
# format-volumes.sh adds (stored in the password manager).
#
# Flags: --dry-run, --tenant PATH, -h
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/ops-common.sh
source "$HERE/../lib/ops-common.sh"
# shellcheck source=luks-common.sh
source "$HERE/luks-common.sh"
usage() { ops_usage "${BASH_SOURCE[0]}"; }

ops_init create-keyfiles "$@"
(( ${#OPS_ARGS[@]} == 0 )) || die "unknown argument: ${OPS_ARGS[0]}"
require_root

if [[ -d /etc/pd ]]; then :; else run install -d -m 0700 -o root -g root /etc/pd; fi
if [[ -d "$LUKS_KEY_DIR" ]]; then
  [[ "$(stat -c %a "$LUKS_KEY_DIR")" == 700 ]] || run chmod 0700 "$LUKS_KEY_DIR"
else
  run install -d -m 0700 -o root -g root "$LUKS_KEY_DIR"
fi

for role in data backup; do
  key="$(luks_key "$role")"
  if [[ -e "$key" ]]; then
    [[ -f "$key" && ! -L "$key" ]] || die "$key exists but is not a regular file"
    size="$(stat -c %s "$key")"
    [[ "$size" == 64 ]] || die "$key exists with size $size (expected 64). Not touching it; investigate."
    [[ "$(stat -c %a "$key")" == 400 ]] || run chmod 0400 "$key"
    [[ "$(stat -c %u:%g "$key")" == 0:0 ]] || run chown root:root "$key"
    log "exists, kept: $key"
    continue
  fi
  # umask 0377 -> file is created 0400; conv=excl -> fails if the file appeared meanwhile.
  run bash -c "umask 0377 && dd if=/dev/urandom of='$key' bs=64 count=1 conv=excl status=none"
  if ! is_dry; then
    [[ "$(stat -c %s "$key")" == 64 ]] || die "$key was not written correctly"
  fi
  is_dry || log "created: $key"
done

log "Next: format-volumes.sh (adds a passphrase keyslot; store each passphrase in the password manager)."
