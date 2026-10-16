#!/usr/bin/env bash
# infra/scripts/setup-server.sh - one-time setup of the PD application host (runs ON THE SERVER, as root).
# Implements: docs/plans/01-infrastructure.md s2/s3 (Drive PR #3 layout). Run it once on an Ubuntu 24.04
# server that already has the PD base system: either created by infra/provision.sh (cloud-init) or brought up
# with infra/server/bootstrap-existing.sh. It does not create the base system itself.
#
# Steps:
#   1. refuse unless Ubuntu 24.04
#   2. refuse unless the base system is there (/etc/pd/bootstrap.done, or cloud-init finished on first boot)
#   3. Docker Engine and the compose v2 plugin from Docker's apt repository (infra/server/install-docker.sh)
#   4. the host firewall (pd-host-firewall.service) must be active; it is applied when not
#   5. refuse when ufw is active: two firewalls conflict, and ufw is never installed or enabled here
#   6. create /opt/pd (root 0755) and /var/log/pd (0750)
#   7. print the next steps (LUKS volumes, deploy, deploy user)
#
# It no longer installs docker.io or the legacy docker-compose v1 (deploy.sh needs `docker compose`), no
# Node/pnpm (the images build with pnpm inside), no ufw, no certbot, and creates no /data directories
# (data lives on the encrypted /mnt/pddata, created by infra/luks/configure-boot.sh).
#
# Usage: sudo infra/scripts/setup-server.sh [--dry-run] [--tenant PATH]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/ops-common.sh
source "$SCRIPT_DIR/../lib/ops-common.sh"
usage() { ops_usage "${BASH_SOURCE[0]}"; }

ops_init setup-server "$@"
(( ${#OPS_ARGS[@]} == 0 )) || die "unknown argument: ${OPS_ARGS[0]} (see --help)"
require_root

ETC="${PD_ETC:-/etc/pd}"
OS_RELEASE="${PD_OS_RELEASE:-/etc/os-release}"
CLOUD_DONE="${PD_CLOUD_BOOT_FINISHED:-/var/lib/cloud/instance/boot-finished}"
INFRA_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_DIR="${PD_PROJECT_DIR:-$(tenant_get backup.project_dir /opt/pd)}"
LOG_DIR="${PD_LOG_DIR:-/var/log/pd}"

# precondition MSG: dies on a failed check, but only warns under --dry-run so the plan can still be printed.
precondition() {
  if is_dry; then warn "$1 (dry-run continues; a real run would stop here)"; else die "$1"; fi
}

echo "== 1. Operating system"
if [[ -r "$OS_RELEASE" ]]; then
  # shellcheck source=/dev/null  # /etc/os-release (PD_OS_RELEASE in tests), read in a subshell
  os="$(. "$OS_RELEASE" && echo "${ID:-?} ${VERSION_ID:-?}")"
else
  os="unknown"
fi
if [[ "$os" == "ubuntu 24.04" ]]; then echo "ok: $os"; else precondition "OS is '$os', PD is built for Ubuntu 24.04"; fi

echo "== 2. Base system (cloud-init or bootstrap-existing.sh)"
if [[ -e "$ETC/bootstrap.done" || -e "$CLOUD_DONE" ]]; then
  echo "ok: base system present"
else
  precondition "no base system found ($ETC/bootstrap.done and $CLOUD_DONE are both missing): run infra/server/bootstrap-existing.sh from the build machine first"
fi

echo "== 3. Docker Engine + compose plugin"
run bash "$INFRA_DIR/server/install-docker.sh" ${PD_TENANT:+--tenant "$PD_TENANT"}

echo "== 4. Host firewall"
if is_dry; then
  echo "[dry-run] systemctl is-active pd-host-firewall; if not active: infra/server/host-firewall.sh apply"
elif systemctl is-active --quiet pd-host-firewall.service; then
  echo "ok: pd-host-firewall.service is active"
else
  run bash "$INFRA_DIR/server/host-firewall.sh" apply ${PD_TENANT:+--tenant "$PD_TENANT"}
fi

echo "== 5. ufw must not be active"
if have ufw && ufw status 2>/dev/null | grep -q '^Status: active'; then
  precondition "ufw is active. PD uses the nftables host firewall (table inet pd_fw); two firewalls conflict. Disable ufw (ufw disable) and re-run. This script never installs or enables ufw."
else
  echo "ok: ufw is not active"
fi

echo "== 6. Directories"
run install -d -m 0755 -o root -g root "$PROJECT_DIR"
run install -d -m 0750 -o root -g root "$LOG_DIR"

echo
echo "Server setup complete. Next steps:"
echo "  1. Encrypted volumes (LUKS): infra/luks/README.md"
echo "       identify-volumes.sh, create-keyfiles.sh, format-volumes.sh, configure-boot.sh  (mounts /mnt/pddata and /mnt/pdbackup)"
echo "  2. Put the app settings in $PROJECT_DIR/.env (root, mode 600) from .env.example"
echo "  3. Deploy: sudo infra/scripts/deploy.sh   (checks the mounts first)"
echo "  4. CI deploys: sudo infra/server/deploy-user.sh --pubkey FILE --confirm"
echo "  5. Backups: infra/scripts/backup.sh --init, then ops/backup/rclone-setup.sh and ops/install.sh"
