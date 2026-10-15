#!/usr/bin/env bash
# infra/server/install-docker.sh   (runs ON THE SERVER, as root via sudo)
# Implements: docs/plans/01-infrastructure.md (Docker). Steps follow Docker's "Install using
# the apt repository" page for Ubuntu (verified against docs.docker.com/engine/install/ubuntu/):
# keyring + docker.sources, then docker-ce docker-ce-cli containerd.io docker-buildx-plugin
# docker-compose-plugin. Not the Ubuntu docker.io package.
#
# Then: /etc/docker/daemon.json (json-file log rotation 10m x 5), restart Docker only if that file
# changed, run hello-world, and assert the admin user is NOT in the docker group (docker group ==
# root; use `sudo docker`).
#
# Usage: sudo install-docker.sh [--dry-run] [--tenant PATH]
# Idempotent: every step checks the current state first. Safe to run twice.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/tenant.sh
. "$SCRIPT_DIR/../lib/tenant.sh"

usage() {
  sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
}

pd_parse_args "$@"
[[ ${#PD_REST[@]} -eq 0 ]] || pd_die "unknown argument: ${PD_REST[0]}"

ADMIN_USER="$(tenant_get server.admin_user)"
need_root

KEYRING=/etc/apt/keyrings/docker.asc
SOURCES=/etc/apt/sources.list.d/docker.sources
PKGS=(docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin)

echo "== 1. Conflicting unofficial packages (docker.io, podman-docker, ...)"
conflicts=()
if have dpkg-query; then
  for p in docker.io docker-compose docker-compose-v2 docker-doc podman-docker containerd runc; do
    if dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q '^install ok installed'; then conflicts+=("$p"); fi
  done
fi
if (( ${#conflicts[@]} )); then
  pd_die "conflicting packages installed: ${conflicts[*]}. Remove them first (docs.docker.com 'Uninstall old versions'); this script does not remove packages."
fi
echo "none"

echo "== 2. Docker apt repository"
run apt-get update -qq
run apt-get install -y ca-certificates curl
run install -m 0755 -d /etc/apt/keyrings
if [[ ! -s "$KEYRING" ]]; then
  run curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o "$KEYRING"
else
  echo "keyring present: $KEYRING"
fi
run chmod a+r "$KEYRING"

if (( PD_DRY_RUN )); then
  codename='<ubuntu codename, from /etc/os-release>'
  arch='<dpkg architecture>'
else
  # shellcheck disable=SC1091
  codename="$(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")"
  arch="$(dpkg --print-architecture)"
fi
write_file "$SOURCES" 644 <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $codename
Components: stable
Architectures: $arch
Signed-By: $KEYRING
EOF
run apt-get update -qq

echo "== 3. Docker Engine packages"
missing=()
for p in "${PKGS[@]}"; do
  if (( PD_DRY_RUN )) || ! dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q '^install ok installed'; then
    missing+=("$p")
  fi
done
if (( ${#missing[@]} )); then
  run apt-get install -y "${PKGS[@]}"
else
  echo "all installed"
fi

echo "== 4. /etc/docker/daemon.json (log rotation)"
daemon_changed=0
DAEMON=/etc/docker/daemon.json
NEW_DAEMON='{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "5" }
}'
if [[ -f "$DAEMON" ]] && ! printf '%s\n' "$NEW_DAEMON" | cmp -s - "$DAEMON"; then
  run cp -a "$DAEMON" "$DAEMON.bak-$(date +%Y%m%d%H%M%S)"
fi
if [[ ! -f "$DAEMON" ]] || ! printf '%s\n' "$NEW_DAEMON" | cmp -s - "$DAEMON"; then
  daemon_changed=1
fi
printf '%s\n' "$NEW_DAEMON" | write_file "$DAEMON" 644
if (( daemon_changed )) || (( PD_DRY_RUN )); then
  run systemctl restart docker
fi
run systemctl enable --now docker

echo "== 5. hello-world"
run docker run --rm hello-world

echo "== 6. $ADMIN_USER must not be in the docker group"
if (( PD_DRY_RUN )); then
  echo "[dry-run] would check: id -nG $ADMIN_USER | grep -w docker  (must be absent)"
elif id -nG "$ADMIN_USER" 2>/dev/null | tr ' ' '\n' | grep -qx docker; then
  pd_die "$ADMIN_USER is in the docker group (= root). Run: gpasswd -d $ADMIN_USER docker"
else
  echo "ok: $ADMIN_USER is not in the docker group (use: sudo docker ...)"
fi

echo "done."
