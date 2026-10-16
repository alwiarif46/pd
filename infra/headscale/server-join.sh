#!/usr/bin/env bash
# infra/headscale/server-join.sh - plan 01 "After first boot" step 2: join PD
# server (tenant.hostname) to the admin network. Run as root ON THE PD SERVER.
#
# Steps (skipped when done):
#   1. Tailscale from the official apt repository (pkgs.tailscale.com, signed-by keyring;
#      same packages as tailscale.com/install.sh, without piping a script into sh).
#      Headscale 0.29.4 needs Tailscale >= 1.80; the script checks.
#   2. tailscale up --login-server=<admin_network.login_server> --hostname=<tenant.hostname>
#        --advertise-tags=<server_tag> --accept-dns=false --auth-key=file:<tmpfile>
#      The pre-auth key (create-preauth-key.sh --server from the Drive repository, on the Headscale
#      host) is read from $PD_TS_AUTHKEY or stdin (hidden prompt on a terminal),
#      written to a 0600 file under /run and passed as file:<path>, so it never appears
#      in argv, `ps` or shell history; the file is shredded on exit.
#      --accept-dns=false: the server keeps its own resolvers, so a tailnet problem can
#      never break ACME, Docker pulls or B2 backups.
#      No --ssh: OpenSSH with keys stays the SSH server; the Headscale policy only opens
#      TCP 22 to the server tag from group:admins.
#   3. Already joined to the same login server with the tag -> no-op.
# Afterwards: test SSH over the tailnet IP from an admin laptop, THEN confirm the
# provider firewall (if any) has no TCP 22 rule.
#
# Flags: --dry-run, --tenant PATH, -h
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/ops-common.sh
source "$HERE/../lib/ops-common.sh"
usage() { ops_usage "${BASH_SOURCE[0]}"; }

ops_init server-join "$@"
(( ${#OPS_ARGS[@]} == 0 )) || die "unknown argument: ${OPS_ARGS[0]}"
require_root

LOGIN_SERVER="$(tget admin_network.login_server)"
SERVER_TAG="$(tget admin_network.server_tag)"
HOSTNAME_WANT="$(tget tenant.hostname)"
MIN_TS=1.80.0

if [[ "$(short_host)" != "$HOSTNAME_WANT" ]]; then
  is_dry && warn "hostname is not $HOSTNAME_WANT (dry-run continues)" \
         || die "this is $(short_host), not $HOSTNAME_WANT"
fi

# 1. install
if have tailscale; then
  log "tailscale present: $(tailscale version 2>/dev/null | head -1)"
else
  codename="$( (. /etc/os-release && echo "${VERSION_CODENAME:-}") 2>/dev/null || true)"
  codename="${codename:-noble}"
  run install -d -m 0755 /usr/share/keyrings
  run curl -fsSL --proto '=https' -o /usr/share/keyrings/tailscale-archive-keyring.gpg \
    "https://pkgs.tailscale.com/stable/ubuntu/${codename}.noarmor.gpg"
  run curl -fsSL --proto '=https' -o /etc/apt/sources.list.d/tailscale.list \
    "https://pkgs.tailscale.com/stable/ubuntu/${codename}.tailscale-keyring.list"
  run apt-get update
  run apt-get install -y tailscale
fi
run systemctl enable --now tailscaled

if have tailscale; then
  v="$(tailscale version | head -1)"
  if [[ "$(printf '%s\n%s\n' "$MIN_TS" "$v" | sort -V | head -1)" != "$MIN_TS" ]]; then
    die "tailscale $v is older than $MIN_TS (Headscale 0.29 minimum)"
  fi
fi

# 3. already joined?
if have tailscale && ! is_dry; then
  st="$(tailscale status --json 2>/dev/null || echo '{}')"
  joined="$(python3 - "$st" "$SERVER_TAG" <<'PY'
import json, sys
s = json.loads(sys.argv[1] or "{}")
tags = (s.get("Self") or {}).get("Tags") or []
print("yes" if s.get("BackendState") == "Running" and sys.argv[2] in tags else "no")
PY
)"
  cur_ctl="$(tailscale debug prefs 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin).get("ControlURL",""))' 2>/dev/null || true)"
  if [[ "$joined" == yes && ( -z "$cur_ctl" || "${cur_ctl%/}" == "${LOGIN_SERVER%/}" ) ]]; then
    log "already joined to $LOGIN_SERVER with $SERVER_TAG: $(tailscale ip -4 2>/dev/null | head -1)"
    exit 0
  fi
fi

# 2. join
KEYFILE=""
cleanup() { [[ -n "$KEYFILE" && -f "$KEYFILE" ]] && shred -u "$KEYFILE" 2>/dev/null || rm -f "${KEYFILE:-/nonexistent}"; }
trap cleanup EXIT

if is_dry; then
  run tailscale up --login-server="$LOGIN_SERVER" --hostname="$HOSTNAME_WANT" \
    --advertise-tags="$SERVER_TAG" --accept-dns=false --auth-key=file:/run/pd-ts-authkey.XXXXXX
  exit 0
fi

key="${PD_TS_AUTHKEY:-}"
unset PD_TS_AUTHKEY
if [[ -z "$key" ]]; then
  if [[ -t 0 ]]; then read -r -s -p "Pre-auth key (from create-preauth-key.sh --server): " key; echo >&2
  else IFS= read -r key || true; fi
fi
[[ -n "$key" ]] || die "no pre-auth key given (stdin or PD_TS_AUTHKEY)"
KEYFILE="$(umask 077 && mktemp /run/pd-ts-authkey.XXXXXX)"
printf '%s' "$key" >"$KEYFILE"
unset key

run tailscale up --login-server="$LOGIN_SERVER" --hostname="$HOSTNAME_WANT" \
  --advertise-tags="$SERVER_TAG" --accept-dns=false --auth-key="file:$KEYFILE"

ip4="$(tailscale ip -4 | head -1)"
log "joined. Admin-network IP: $ip4"
cat >&2 <<EOF
Next (in this order):
  1. From an admin laptop on the tailnet: ssh $(tget server.admin_user)@$ip4   (key login works)
  2. Only then remove the temporary rule: infra/firewall-temp-ssh.sh remove --check-host <name> (laptop).
  3. On the Headscale host (Drive repository): infra/headscale/server-key-expiry.sh, or check in Headscale that the tagged node never expires
EOF
