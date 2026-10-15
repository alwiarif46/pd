#!/usr/bin/env bash
# infra/server/deploy-user.sh - create the CI deploy user `pddeploy` (runs ON THE SERVER, as root).
# Implements: docs/plans/01-infrastructure.md (deploys from CI). The GitHub workflow connects as pddeploy
# over the admin network; that key can do exactly one thing: run `deploy.sh --ci` as root with the requested
# ref (and image tag), through an SSH forced command. No shell, no port forwarding, no other command.
#
#   user         pddeploy: system user, /bin/sh, locked password (no password login)
#   key          ~pddeploy/.ssh/authorized_keys:
#                  restrict,command="sudo -n /opt/pd/infra/scripts/deploy.sh --ci" <public key>
#   sudo         /etc/sudoers.d/pd-deploy (0440, checked with `visudo -cf` before it is moved into place):
#                  pddeploy ALL=(root) NOPASSWD: /opt/pd/infra/scripts/deploy.sh --ci
#                  Defaults!/opt/pd/infra/scripts/deploy.sh env_keep += "SSH_ORIGINAL_COMMAND"
#                sudo strips the environment, and deploy.sh --ci reads the requested ref and tag from
#                SSH_ORIGINAL_COMMAND, so it is kept for that one command. *verify* on the first real run.
#   sshd         /etc/ssh/sshd_config.d/11-pd-deploy.conf: AllowUsers pdadmin pddeploy; then `sshd -t` and reload
#
# Refuses when /opt/pd or deploy.sh is not owned by root or is group/world writable: a deploy user that can
# edit the script it runs as root would be a root shell.
#
# Usage: sudo infra/server/deploy-user.sh --pubkey FILE --confirm
#        infra/server/deploy-user.sh --dry-run [--pubkey FILE]
# Flags: --dry-run, --tenant PATH, --pubkey FILE (a single ssh-ed25519 line: the CI deploy key's PUBLIC half),
#        --confirm (required for a real run), -h
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/ops-common.sh
source "$SCRIPT_DIR/../lib/ops-common.sh"
usage() { ops_usage "${BASH_SOURCE[0]}"; }

ops_init deploy-user "$@"
PUBKEY_FILE="" CONFIRM=0
set -- ${OPS_ARGS[@]+"${OPS_ARGS[@]}"}
while (( $# )); do
  case "$1" in
    --pubkey) PUBKEY_FILE="${2:?--pubkey needs a file}"; shift ;;
    --confirm) CONFIRM=1 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done
(( DRY_RUN || CONFIRM )) || die "this creates a user with a root-running forced command: preview with --dry-run, run with --confirm"
require_root

DEPLOY_USER=pddeploy
PROJECT_DIR="${PD_PROJECT_DIR:-$(tenant_get backup.project_dir /opt/pd)}"
DEPLOY_SH="$PROJECT_DIR/infra/scripts/deploy.sh"
ADMIN_USER="$(tenant_get server.admin_user)"
HOME_DIR="${PD_DEPLOY_HOME:-/home/$DEPLOY_USER}"
SUDOERS_FILE="${PD_SUDOERS_DIR:-/etc/sudoers.d}/pd-deploy"
SSHD_DROPIN="${PD_SSHD_DIR:-/etc/ssh/sshd_config.d}/11-pd-deploy.conf"
FORCED="sudo -n $DEPLOY_SH --ci"

precondition() {
  if is_dry; then warn "$1 (dry-run continues; a real run would stop here)"; else die "$1"; fi
}

# --- the public key
PUBKEY=""
if [[ -n "$PUBKEY_FILE" ]]; then
  [[ -f "$PUBKEY_FILE" ]] || die "public key file not found: $PUBKEY_FILE"
  PUBKEY="$(tr -d '\r' <"$PUBKEY_FILE" | sed '/^[[:space:]]*$/d')"
  [[ "$(printf '%s\n' "$PUBKEY" | wc -l | tr -d ' ')" == 1 ]] || die "$PUBKEY_FILE must hold exactly one public key line"
  [[ "$PUBKEY" == ssh-ed25519\ * ]] || die "$PUBKEY_FILE is not an ssh-ed25519 public key (this must be the PUBLIC half)"
  [[ "$PUBKEY" != *PRIVATE* ]] || die "$PUBKEY_FILE looks like a private key"
else
  precondition "--pubkey FILE is required"
  PUBKEY="ssh-ed25519 <public-key-of-the-CI-deploy-key>"
fi

# --- ownership guard: the root-run script and its directory must not be writable by anyone else
check_owner() { # check_owner PATH
  local p="$1" owner mode
  if [[ ! -e "$p" ]]; then precondition "$p does not exist yet (deploy PD first, or fix PD_PROJECT_DIR)"; return 0; fi
  owner="$(stat -c %U "$p")"; mode="$(stat -c %a "$p")"
  [[ "$owner" == root ]] || precondition "$p is owned by $owner, not root"
  (( (8#$mode & 8#022) == 0 )) || precondition "$p is group- or world-writable (mode $mode)"
}
check_owner "$PROJECT_DIR"
check_owner "$PROJECT_DIR/infra"
check_owner "$PROJECT_DIR/infra/scripts"
check_owner "$DEPLOY_SH"

# --- 1. the user
echo "== 1. User $DEPLOY_USER"
if id "$DEPLOY_USER" >/dev/null 2>&1; then
  echo "exists"
else
  run useradd --system --create-home --home-dir "$HOME_DIR" --shell /bin/sh --comment "PD CI deploy (forced command)" "$DEPLOY_USER"
fi
run passwd -l "$DEPLOY_USER"

# --- 2. authorized_keys with the forced command
echo "== 2. authorized_keys (forced command, restrict)"
run install -d -m 0700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$HOME_DIR/.ssh"
printf 'restrict,command="%s" %s\n' "$FORCED" "$PUBKEY" | ops_install_file "$HOME_DIR/.ssh/authorized_keys" 0600 "$DEPLOY_USER:$DEPLOY_USER"

# --- 3. sudoers, validated before it goes live
echo "== 3. sudoers"
SUDOERS_BODY="# PD CI deploy (infra/server/deploy-user.sh). The key in ~$DEPLOY_USER/.ssh/authorized_keys can only run this.
$DEPLOY_USER ALL=(root) NOPASSWD: $DEPLOY_SH --ci
Defaults!$DEPLOY_SH env_keep += \"SSH_ORIGINAL_COMMAND\""
if is_dry; then
  echo "[dry-run] write $SUDOERS_FILE (0440), checked first with: visudo -cf <tmpfile>"
  printf '%s\n' "$SUDOERS_BODY" | sed 's/^/    | /'
else
  tmp="$(mktemp)"
  trap 'rm -f "$tmp"' EXIT
  printf '%s\n' "$SUDOERS_BODY" >"$tmp"
  chmod 0440 "$tmp"
  visudo -cf "$tmp" >/dev/null || die "sudoers snippet did not validate; nothing installed"
  install -D -m 0440 -o root -g root "$tmp" "$SUDOERS_FILE"
  log "wrote $SUDOERS_FILE"
fi

# --- 4. sshd
echo "== 4. sshd drop-in"
printf '# PD CI deploy user (infra/server/deploy-user.sh)\nAllowUsers %s %s\n' "$ADMIN_USER" "$DEPLOY_USER" | ops_install_file "$SSHD_DROPIN" 0644 root:root
run sshd -t
run systemctl reload ssh

echo
echo "Done. Check from the CI side (admin network): ssh -i <deploy key> $DEPLOY_USER@<host> \"ref=master\""
echo "Anything other than 'ref=<ref>[ tag=<hex>]' is refused by deploy.sh --ci with exit 2."
echo "STATE.md: | $(date +%F) | 01 | CI deploy user | done | $DEPLOY_USER with forced command and sudo rule on $(tenant_get tenant.hostname) |"
