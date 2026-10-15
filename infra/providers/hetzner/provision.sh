#!/usr/bin/env bash
# infra/providers/hetzner/provision.sh - plan 01 on Hetzner Cloud (Drive D-146, D-148).
# Ensures, check-before-create (never deletes, never rescales):
#   Firewall   [infra.hetzner] firewall: in tcp/443, icmp, udp/41641 from any; no SSH; applied
#   SSH key    tenant.ssh_key_name from SSH_PUBKEY_PATH (creation + rescue login)
#   Server     tenant.hostname: CREATED with infra/cloud-init.yaml when missing (type/image/location from
#              [infra.hetzner]); ADOPTED as it is when it exists - only with --adopt-existing, because the
#              firewall then closes SSH and every other port on a running machine (next: firewall-temp-ssh.sh
#              add, then infra/server/bootstrap-existing.sh)
#   Volumes    [volumes] data/backup when [infra] storage = "volumes": attached, unformatted, protected.
#              storage = "root-container": none (LUKS containers on the root disk, D-147)
#   Protection server delete + rebuild protection; Hetzner backups must stay off
# Usage:
#   infra/provision.sh --dry-run                 plan only, no API call
#   infra/provision.sh --confirm-purchase        create for real (billable)
#   infra/provision.sh --confirm-purchase --adopt-existing    also take over a server that already exists
# Common flags: --tenant PATH  --secrets PATH  -h
# Secrets file: HCLOUD_TOKEN (project Read & Write API token), SSH_PUBKEY_PATH, ADMIN_IP.
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/hz-common.sh"
usage() { hz_usage "${BASH_SOURCE[0]}"; }
CONFIRM=0 ADOPT=()
pd_parse_args "$@"
set -- ${PD_REST[@]+"${PD_REST[@]}"}
while (( $# )); do
  case "$1" in
    --confirm-purchase) CONFIRM=1 ;;
    --adopt-existing) ADOPT=(--adopt-existing) ;;
    *) pd_die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done
(( PD_DRY_RUN || CONFIRM )) || pd_die "refusing to create billable resources without --confirm-purchase (preview with --dry-run)"
hz_init
STORAGE="$(provider_storage)"
if (( PD_DRY_RUN )); then
  hz_py provision --dry-run --storage "$STORAGE"
  exit 0
fi
require_secret SSH_PUBKEY_PATH ADMIN_IP
TMPD="$(mktemp -d)"
cleanup() { if have shred; then find "$TMPD" -type f -exec shred -u {} + 2>/dev/null || true; fi; rm -rf "$TMPD"; }
trap cleanup EXIT
render=("$PD_PY" "$(pd_native_path "$HZ_DIR/../../render-cloud-init.py")" --out "$(pd_native_path "$TMPD/user-data.yaml")")
[[ -n "${PD_TENANT:-}" ]] && render+=(--tenant "$(pd_native_path "$PD_TENANT")")
[[ -n "${PD_SECRETS:-}" ]] && render+=(--secrets "$(pd_native_path "$PD_SECRETS")")
# The user-data is only used when the server is created; rendering it every time keeps one code path.
"${render[@]}" >/dev/null
SSH_PUBKEY_PATH="$(pd_unix_path "$SSH_PUBKEY_PATH")"
export SSH_PUBKEY_PATH
hz_py provision --confirm-purchase ${ADOPT[@]+"${ADOPT[@]}"} --storage "$STORAGE" --user-data "$(pd_native_path "$TMPD/user-data.yaml")"
echo "Next: DNS (python infra/dns/cloudflare-dns.py apply --from-provider), then the temporary SSH window (infra/README.md step 4)."
