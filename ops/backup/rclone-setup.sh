#!/usr/bin/env bash
# ops/backup/rclone-setup.sh - set up rclone for the off-site B2 copy (runs ON THE SERVER, as root).
# Implements: docs/plans/01-infrastructure.md s4 (Drive PR #3 ops/backup/rclone-setup.sh, trimmed).
#
#   1. /etc/pd/rclone.conf (0644, NO secrets) rendered from ops/backup/rclone.conf.template with
#      [backup] bucket and crypt_prefix from the tenant file.
#   2. /etc/pd/rclone.env (0600) from hidden prompts: the B2 application key id and key (the server key: no
#      deleteFiles capability, scoped to the bucket and prefix; HUMAN-TODO H-03) and the two rclone crypt
#      passwords. The crypt passwords go through `rclone obscure -` (stdin), so no secret is ever in argv.
#      The plain crypt passwords must also go into the vault (H-03): without them the B2 copy cannot be read.
# It does not talk to Backblaze: creating the bucket, lifecycle rules and keys is manual (H-03). There is no B2 API
# script on purpose; the server key could not delete files anyway.
#
# Usage: sudo ops/backup/rclone-setup.sh [--dry-run] [--tenant PATH] [--conf-only]
#   --conf-only   write rclone.conf only (no prompts, no rclone.env)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../infra/lib/ops-common.sh
source "$HERE/../../infra/lib/ops-common.sh"
# shellcheck source=../lib/backup-common.sh
source "$HERE/../lib/backup-common.sh"
usage() { ops_usage "${BASH_SOURCE[0]}"; }

ops_init rclone-setup "$@"
CONF_ONLY=0
set -- ${OPS_ARGS[@]+"${OPS_ARGS[@]}"}
while (( $# )); do
  case "$1" in
    --conf-only) CONF_ONLY=1 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done
require_root
BUCKET="$(tget backup.bucket)"
PREFIX="$(tget backup.crypt_prefix)"
[[ "$BUCKET" =~ ^[A-Za-z0-9-]{6,50}$ ]] || die "[backup] bucket looks wrong: $BUCKET"
[[ "$PREFIX" =~ ^[A-Za-z0-9._-]{1,60}$ ]] || die "[backup] crypt_prefix looks wrong: $PREFIX"

ops_render "$HERE/rclone.conf.template" "BUCKET=$BUCKET" "CRYPT_PREFIX=$PREFIX" | ops_install_file "$PD_ETC/rclone.conf" 0644 root:root

if (( CONF_ONLY )); then exit 0; fi
if is_dry; then
  echo "[dry-run] would ask (hidden) for: B2 key id, B2 application key, crypt password, crypt salt password;"
  echo "[dry-run] obscure the two crypt passwords with: rclone obscure -   (stdin)"
  echo "[dry-run] and write $PD_ETC/rclone.env (mode 0600) with RCLONE_CONFIG_B2_ACCOUNT, _B2_KEY, _B2CRYPT_PASSWORD, _B2CRYPT_PASSWORD2"
  exit 0
fi
[[ -t 0 ]] || die "needs an interactive terminal for the hidden prompts"
require_cmd rclone
if [[ -e "$PD_ETC/rclone.env" ]]; then die "$PD_ETC/rclone.env already exists; remove it deliberately to replace the keys"; fi

ask() { # ask VAR PROMPT : hidden prompt into VAR
  local v
  read -r -s -p "$2: " v; echo >&2
  [[ -n "$v" ]] || die "empty value"
  printf -v "$1" '%s' "$v"
}
ask ACCOUNT "B2 application key id (the server key, without deleteFiles)"
ask KEY "B2 application key"
ask CP1 "rclone crypt password (a long random one; it also goes into the vault)"
ask CP2 "rclone crypt salt password (a second long random one; vault too)"
OB1="$(printf '%s' "$CP1" | rclone obscure -)"
OB2="$(printf '%s' "$CP2" | rclone obscure -)"
unset CP1 CP2
umask 077
{
  printf 'RCLONE_CONFIG_B2_ACCOUNT=%s\n' "$ACCOUNT"
  printf 'RCLONE_CONFIG_B2_KEY=%s\n' "$KEY"
  printf 'RCLONE_CONFIG_B2CRYPT_PASSWORD=%s\n' "$OB1"
  printf 'RCLONE_CONFIG_B2CRYPT_PASSWORD2=%s\n' "$OB2"
} >"$PD_ETC/rclone.env"
chmod 0600 "$PD_ETC/rclone.env"
unset ACCOUNT KEY OB1 OB2
log "wrote $PD_ETC/rclone.env (0600). Check the first upload with: sudo ops/backup/offsite-sync.sh"
