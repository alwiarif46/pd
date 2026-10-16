#!/usr/bin/env bash
# infra/server/host-firewall.sh   (apply / allow-ssh / close-ssh / status / refresh-cloudflare run ON THE SERVER as root; render runs anywhere)
# Implements: docs/plans/01-infrastructure.md s3 (Drive D-135): the host firewall. Inbound: TCP 443 from
# Cloudflare's published ranges only ([network] cloudflare_only; no port 80), ICMP, UDP 41641 (Tailscale),
# DHCP replies, SSH only on tailscale0 (plus a timed bootstrap set and the optional [network] admin_ssh_cidrs),
# containers on Docker bridges; everything else dropped. Cloud-init installs it at first boot.
#
# Actions
#   render                          print the filled ruleset to stdout (template infra/server/host-firewall.nft,
#                                   Cloudflare list, [network] values). Refuses an empty or invalid Cloudflare list.
#   apply [--force]                 render, install as /etc/pd/host-firewall.nft and the pd-host-firewall.service
#                                   unit, syntax-check, enable, load. Unchanged files on an active unit = nothing
#                                   reloaded (the bootstrap window stays as it is). A reload empties the bootstrap
#                                   sets, so it refuses when this shell is an SSH session that does not come over
#                                   the admin network (lockout guard) unless --force.
#   allow-ssh --ip IP [--hours N]   admit SSH from one public IP for N hours (default [infra]
#                                   bootstrap_ssh_hours); pair it with infra/firewall-temp-ssh.sh add
#   close-ssh                       empty both bootstrap sets now
#   status                          print the table and the bootstrap elements
#   refresh-cloudflare              (server only) fetch https://www.cloudflare.com/ips-v4 and /ips-v6, validate every
#                                   entry, write /etc/pd/cloudflare-ips.txt (0644) and apply. Tests never call it.
# Flags: --dry-run, --tenant PATH, -h. Idempotent; never touches Docker's or Tailscale's tables.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/tenant.sh
. "$SCRIPT_DIR/../lib/tenant.sh"

usage() {
  sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
}

ACTION="" FORCE=0 IP="" HOURS=""
pd_parse_args "$@"
set -- ${PD_REST[@]+"${PD_REST[@]}"}
while (( $# )); do
  case "$1" in
    render | apply | allow-ssh | close-ssh | status | refresh-cloudflare) [[ -z "$ACTION" ]] || pd_die "only one action"; ACTION="$1" ;;
    --force) FORCE=1 ;;
    --ip) IP="${2:?--ip needs a value}"; shift ;;
    --hours) HOURS="${2:?--hours needs a value}"; shift ;;
    *) pd_die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done
[[ -n "$ACTION" ]] || { usage; pd_die "action required: render | apply | allow-ssh | close-ssh | status | refresh-cloudflare"; }

TABLE=(inet pd_fw)
ETC="${PD_ETC:-/etc/pd}"
SRC_UNIT="$SCRIPT_DIR/pd-host-firewall.service"
DST_NFT="$ETC/host-firewall.nft"
DST_IPS="$ETC/cloudflare-ips.txt"
DST_UNIT="${PD_UNIT_DIR:-/etc/systemd/system}/pd-host-firewall.service"

# The list the firewall is built from: the server's own copy when it exists (refresh-cloudflare writes it),
# else the one shipped in the repository.
ips_file() {
  if [[ -f "$DST_IPS" ]]; then printf '%s' "$DST_IPS"; else printf '%s' "$SCRIPT_DIR/cloudflare-ips.txt"; fi
}

# render_to_stdout: the filled ruleset. A failure here (empty or invalid list) must stop the caller.
render_to_stdout() {
  pd_find_python
  local args=(render --ips "$(pd_native_path "$(ips_file)")")
  [[ -n "${PD_TENANT:-}" ]] && args+=(--tenant "$(pd_native_path "$PD_TENANT")")
  "$PD_PY" "$(pd_native_path "$PD_LIB_DIR/fwrender.py")" "${args[@]}"
}

if (( ! PD_DRY_RUN )) && [[ "$ACTION" != render ]]; then
  need_root
  have nft || pd_die "nft not found (apt-get install nftables)"
fi

# Does this shell come in over SSH from outside the admin network?
ssh_from_public() {
  local client="${SSH_CONNECTION%% *}"
  [[ -n "${SSH_CONNECTION:-}" ]] || return 1
  case "$client" in
    100.6[4-9].* | 100.[7-9][0-9].* | 100.1[01][0-9].* | 100.12[0-7].* | fd7a:115c:a1e0:*) return 1 ;;
  esac
  return 0
}

case "$ACTION" in
  render)
    render_to_stdout
    ;;
  apply)
    tmp="$(mktemp)"
    trap 'rm -f "$tmp"' EXIT
    render_to_stdout >"$tmp" || pd_die "could not render the firewall (see above); nothing changed"
    [[ -s "$tmp" ]] || pd_die "rendered firewall is empty; nothing changed"
    changed=0
    if [[ -f "$DST_NFT" ]] && cmp -s "$tmp" "$DST_NFT"; then
      echo "unchanged: $DST_NFT"
    else
      changed=1
      run install -D -m 0600 -o root -g root "$tmp" "$DST_NFT"
    fi
    if [[ -f "$DST_UNIT" ]] && cmp -s "$SRC_UNIT" "$DST_UNIT"; then
      echo "unchanged: $DST_UNIT"
    else
      changed=1
      run install -D -m 0644 -o root -g root "$SRC_UNIT" "$DST_UNIT"
    fi
    run nft -c -f "$DST_NFT"
    active=0
    (( PD_DRY_RUN )) || { systemctl is-active --quiet pd-host-firewall.service && active=1; }
    if (( active && ! changed )); then
      echo "host firewall active and unchanged - nothing reloaded"
    else
      if (( active )) && ssh_from_public && ! ip link show tailscale0 >/dev/null 2>&1 && (( ! FORCE )); then
        pd_die "reloading empties the bootstrap SSH set and this SSH session comes over the public network with no tailscale0 yet: join the admin network first (or --force)"
      fi
      run systemctl daemon-reload
      run systemctl enable pd-host-firewall.service
      if (( active )); then run systemctl reload pd-host-firewall.service; else run systemctl start pd-host-firewall.service; fi
    fi
    (( PD_DRY_RUN )) || nft list table "${TABLE[@]}" >/dev/null || pd_die "table ${TABLE[*]} not loaded"
    echo "host firewall: inbound 443 (Cloudflare ranges only unless [network] cloudflare_only = false), ICMP, UDP 41641, SSH on tailscale0 (+ timed bootstrap set); policy drop; no port 80"
    ;;
  allow-ssh)
    [[ -n "$IP" ]] || pd_die "allow-ssh needs --ip IP"
    pd_find_python
    cidr="$("$PD_PY" "$(pd_native_path "$SCRIPT_DIR/../lib/netutil.py")" cidr "$IP")" || pd_die "refusing '$IP'"
    HOURS="${HOURS:-$(tenant_get infra.bootstrap_ssh_hours 6)}"
    if ! [[ "$HOURS" =~ ^[0-9]+$ ]] || (( HOURS < 1 || HOURS > 24 )); then pd_die "--hours must be 1-24"; fi
    set_name=bootstrap_ssh4; [[ "$cidr" == *:* ]] && set_name=bootstrap_ssh6
    run nft add element "${TABLE[@]}" "$set_name" "{ ${cidr%/*} timeout ${HOURS}h }"
    echo "SSH admitted from ${cidr%/*} for ${HOURS} h (host firewall). A provider firewall, if any, needs its own rule: infra/firewall-temp-ssh.sh add"
    ;;
  close-ssh)
    run nft flush set "${TABLE[@]}" bootstrap_ssh4
    run nft flush set "${TABLE[@]}" bootstrap_ssh6
    echo "bootstrap SSH sets emptied: public SSH is closed on the host"
    ;;
  status)
    run nft list table "${TABLE[@]}"
    ;;
  refresh-cloudflare)
    # Runs on the server. This is the ONLY action that makes a network request, to Cloudflare's public IP lists.
    have curl || pd_die "curl not found"
    tmp4="$(mktemp)"; tmp6="$(mktemp)"; tmpl="$(mktemp)"
    trap 'rm -f "$tmp4" "$tmp6" "$tmpl"' EXIT
    run curl -fsS --proto '=https' --max-time 30 -o "$tmp4" https://www.cloudflare.com/ips-v4
    run curl -fsS --proto '=https' --max-time 30 -o "$tmp6" https://www.cloudflare.com/ips-v6
    if (( PD_DRY_RUN )); then
      echo "[dry-run] validate both lists, write $DST_IPS (0644), then: host-firewall.sh apply"
      exit 0
    fi
    {
      echo "# source: https://www.cloudflare.com/ips-v4 and https://www.cloudflare.com/ips-v6, fetched $(date -u +%F); refresh: infra/server/host-firewall.sh refresh-cloudflare"
      tr -d '\r' <"$tmp4"; echo
      tr -d '\r' <"$tmp6"; echo
    } >"$tmpl"
    pd_find_python
    # validate before anything is installed: the same parser the firewall render uses
    "$PD_PY" -c 'import sys; sys.path.insert(0, sys.argv[1]); import fwrender; v4, v6 = fwrender.parse_cloudflare(open(sys.argv[2]).read()); print(len(v4), "IPv4 and", len(v6), "IPv6 ranges")' \
      "$(pd_native_path "$PD_LIB_DIR")" "$(pd_native_path "$tmpl")" || pd_die "the fetched lists did not validate; $DST_IPS unchanged"
    run install -D -m 0644 -o root -g root "$tmpl" "$DST_IPS"
    exec bash "$SCRIPT_DIR/host-firewall.sh" apply ${PD_TENANT:+--tenant "$PD_TENANT"}
    ;;
esac
