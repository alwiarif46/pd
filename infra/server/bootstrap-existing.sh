#!/usr/bin/env bash
# infra/server/bootstrap-existing.sh - apply infra/cloud-init.yaml to a machine that already runs
# (Drive D-146, D-148). Runs on the BUILD MACHINE.
#
# Why: a server created by infra/provision.sh gets the rendered user-data at first boot. A server that was
# ordered by hand (Contabo, the generic `ssh` adapter) or adopted (an existing Hetzner server; Hetzner's
# rebuild cannot take user-data) never saw it. This script gives it exactly the same first boot, from the
# same template, so there is one definition of the base server (admin user, sshd, host firewall,
# unattended upgrades, swap, sysctl):
#   1. render the user-data locally (infra/render-cloud-init.py; written outside the repo, shredded after)
#   2. copy it over root SSH into /etc/pd/cloud-seed/ (0600; it holds the pdadmin password HASH)
#   3. point cloud-init at it as a NoCloud seed with a NEW instance id, keep the provider's network config
#      (network: {config: disabled}, so netplan is not rewritten and a static IPv6 survives)
#   4. `cloud-init schema` check, then run the four cloud-init stages now (no reboot)
#   5. shred the seed and cloud-init's own copies of the user-data, disable cloud-init for later boots (the
#      seed is gone; a later boot must not see a new instance and rerun first-boot modules), mark
#      /etc/pd/bootstrap.done, and prove `ssh <admin>@<ip> true` works with the key
#   Host keys are KEPT (ssh_deletekeys: false), so the fingerprint you already trust stays valid.
#   With a provider firewall (hetzner, ovh-us) root SSH must be open first: infra/firewall-temp-ssh.sh add.
# After it: root SSH and password SSH are off, public SSH is open only from ADMIN_IP for
# [infra] bootstrap_ssh_hours (host firewall), then over the admin network only (infra/README.md step 4).
#
# Refuses: a second run (bootstrap.done), an OS other than Ubuntu 24.04, a host already carrying the
# admin user with a different key. Never touches disks (LUKS is plan 01).
#
# Usage:
#   bootstrap-existing.sh --dry-run                       show the plan and the remote script
#   bootstrap-existing.sh --confirm [--host IP] [--user root]
# Common flags: --tenant PATH  --secrets PATH  -h
# Host: --host, else infra/server-addresses.sh (the provider adapter). Login: --user, else
# [infra.ssh] bootstrap_user, else root. Secrets file: SSH_PUBKEY_PATH, ADMIN_IP; PDADMIN_HASH or a prompt
# (see infra/render-cloud-init.py).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/tenant.sh
. "$SCRIPT_DIR/../lib/tenant.sh"
# shellcheck source=../lib/provider.sh
. "$SCRIPT_DIR/../lib/provider.sh"
usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }

CONFIRM=0 HOST_ARG="" USER_ARG=""
pd_parse_args "$@"
set -- ${PD_REST[@]+"${PD_REST[@]}"}
while (( $# )); do
  case "$1" in
    --confirm) CONFIRM=1 ;;
    --host) HOST_ARG="${2:?--host needs a value}"; shift ;;
    --user) USER_ARG="${2:?--user needs a value}"; shift ;;
    *) pd_die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done
(( PD_DRY_RUN || CONFIRM )) || pd_die "this changes the server (admin user, sshd, firewall): preview with --dry-run, run with --confirm"

ADMIN_USER="$(tenant_get server.admin_user)"
HOSTNAME_="$(tenant_get tenant.hostname)"
LOGIN="${USER_ARG:-$(tenant_get infra.ssh.bootstrap_user root)}"
[[ "$LOGIN" =~ ^[a-z_][a-z0-9_-]*$ ]] || pd_die "bad login user: $LOGIN"
load_secrets
provider_tenant_args
if [[ -n "$HOST_ARG" ]]; then
  IP="$HOST_ARG"
elif (( PD_DRY_RUN )); then
  IP="<server-ipv4>"
else
  read -r IP _ < <(bash "$PD_INFRA_DIR/server-addresses.sh" ${PROVIDER_ARGS[@]+"${PROVIDER_ARGS[@]}"})
  [[ -n "$IP" && "$IP" != "-" ]] || pd_die "could not read the server IPv4 from the provider (pass --host IP)"
fi
pd_find_python
"$PD_PY" -c 'import ipaddress,sys; ipaddress.ip_address(sys.argv[1])' "$IP" 2>/dev/null || (( PD_DRY_RUN )) \
  || pd_die "--host must be an IP address (the server's public IPv4), got '$IP'"

# The remote half. Runs as root on the server via `bash -s`; the seed arrives on stdin as a tar stream.
# shellcheck disable=SC2016  # runs on the server: expands there, not here
REMOTE_SCRIPT='set -euo pipefail
[[ $(id -u) -eq 0 ]] || { echo "must run as root" >&2; exit 1; }
. /etc/os-release
[[ "$ID $VERSION_ID" == "ubuntu 24.04" ]] || { echo "refusing: OS is $ID $VERSION_ID, not ubuntu 24.04" >&2; exit 1; }
[[ ! -e /etc/pd/bootstrap.done ]] || { echo "refusing: /etc/pd/bootstrap.done exists (already bootstrapped)" >&2; exit 1; }
command -v cloud-init >/dev/null || { echo "cloud-init is not installed (apt-get install cloud-init)" >&2; exit 1; }
install -d -m 0700 /etc/pd /etc/pd/cloud-seed
tar --no-same-owner -xf - -C /etc/pd/cloud-seed
chown root:root /etc/pd/cloud-seed/*
chmod 0600 /etc/pd/cloud-seed/*
cloud-init schema --config-file /etc/pd/cloud-seed/user-data
cat >/etc/cloud/cloud.cfg.d/90-pd-seed.cfg <<EOC
# pd: infra/server/bootstrap-existing.sh (D-148). Keep the provider network config; seed from a local dir.
datasource_list: [ NoCloud, None ]
datasource:
  NoCloud:
    seedfrom: file:///etc/pd/cloud-seed/
network: {config: disabled}
ssh_deletekeys: false
EOC
cloud-init clean
cloud-init init --local
cloud-init init
cloud-init modules --mode=config
cloud-init modules --mode=final
rc=0; cloud-init status --long || rc=$?
find /etc/pd/cloud-seed -type f -exec shred -u {} + 2>/dev/null || rm -f /etc/pd/cloud-seed/*
# cloud-init keeps copies of the user-data (with the password hash) under the instance dir: remove them too
find /var/lib/cloud/instances/ -maxdepth 2 -name "user-data.txt*" -type f -exec shred -u {} + 2>/dev/null || true
touch /etc/cloud/cloud-init.disabled
date -u +%FT%TZ >/etc/pd/bootstrap.done
# cloud-init status: 0 done, 2 done with recoverable errors (warnings), 1 error
case $rc in
  0) echo "cloud-init: done" ;;
  2) echo "WARN: cloud-init finished with recoverable errors (see above, /var/log/cloud-init.log)" >&2 ;;
  *) echo "cloud-init failed (see above, /var/log/cloud-init.log)" >&2; exit 1 ;;
esac'

cat <<PLAN
Server          : $HOSTNAME_  $IP  (provider $(tenant_get infra.provider)), first login $LOGIN over SSH
Applies         : infra/cloud-init.yaml rendered for this tenant (admin user $ADMIN_USER with the SSH key and the
                  password hash, sshd key-only + AllowUsers $ADMIN_USER, host firewall with SSH from ADMIN_IP for
                  $(tenant_get infra.bootstrap_ssh_hours 6) h, unattended security upgrades, 4 GB swap, sysctl)
Network config  : left as the provider made it (cloud-init network: config disabled)
After           : $LOGIN SSH stops working by design; check: ssh $ADMIN_USER@$IP true
PLAN
if (( PD_DRY_RUN )); then
  echo "[dry-run] render: infra/render-cloud-init.py --out <tmp>/user-data (outside the repo)"
  echo "[dry-run] ssh $LOGIN@$IP 'bash -s' with the seed as a tar stream; remote script:"
  printf '%s\n' "$REMOTE_SCRIPT" | sed 's/^/    | /'
  echo "[dry-run] then: ssh -o BatchMode=yes $ADMIN_USER@$IP true"
  exit 0
fi
require_secret SSH_PUBKEY_PATH ADMIN_IP
# A provider firewall (fw-pd / sg-pd) has no SSH rule by design: root SSH needs the temporary one.
if [[ -z "$HOST_ARG" && "$(provider_conf firewall)" == api ]]; then
  if [[ -z "$(bash "$PD_INFRA_DIR/ssh-rules.sh" ${PROVIDER_ARGS[@]+"${PROVIDER_ARGS[@]}"} 2>/dev/null | grep -v '^-' || true)" ]]; then
    pd_die "the provider firewall has no temporary SSH rule, so root SSH will time out. First: bash infra/firewall-temp-ssh.sh add$( [[ -n "${PD_TENANT:-}" ]] && printf ' --tenant %s' "$PD_TENANT")"
  fi
fi

TMPD="$(mktemp -d)"
cleanup() { if have shred; then find "$TMPD" -type f -exec shred -u {} + 2>/dev/null || true; fi; rm -rf "$TMPD"; }
trap cleanup EXIT
render=("$PD_PY" "$(pd_native_path "$PD_INFRA_DIR/render-cloud-init.py")" --out "$(pd_native_path "$TMPD/user-data")")
[[ -n "${PD_TENANT:-}" ]] && render+=(--tenant "$(pd_native_path "$PD_TENANT")")
[[ -n "${PD_SECRETS:-}" ]] && render+=(--secrets "$(pd_native_path "$PD_SECRETS")")
"${render[@]}" >/dev/null
printf 'instance-id: pd-bootstrap-%s\nlocal-hostname: %s\n' "$(date -u +%Y%m%d%H%M%S)" "$HOSTNAME_" >"$TMPD/meta-data"
printf '' >"$TMPD/vendor-data"

SSHO=(-o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new)
# The admin user must not exist with someone else's key (a reused box): refuse rather than merge.
pub="$(awk '{print $2}' "$(pd_unix_path "$SSH_PUBKEY_PATH")")"
# shellcheck disable=SC2029  # the admin user name is meant to expand here
existing="$(ssh "${SSHO[@]}" "$LOGIN@$IP" "cat /home/$ADMIN_USER/.ssh/authorized_keys 2>/dev/null || true")" \
  || pd_die "SSH to $LOGIN@$IP failed (is the admin key installed for $LOGIN?)"
if [[ -n "$existing" ]] && ! grep -qF -- "$pub" <<<"$existing"; then
  pd_die "$ADMIN_USER already exists on $IP with other SSH keys; refusing (investigate the box first)"
fi
echo "== applying cloud-init on $IP (package upgrade included; this takes a few minutes)"
# shellcheck disable=SC2029  # the script text is quoted here on purpose (printf %q)
tar -C "$TMPD" -cf - user-data meta-data vendor-data \
  | ssh "${SSHO[@]}" "$LOGIN@$IP" "bash -c $(printf '%q' "$REMOTE_SCRIPT")" \
  || pd_die "remote bootstrap failed (see output above). The provider console still works (infra/break-glass.sh console)."
echo "== checking key login as $ADMIN_USER"
if ssh "${SSHO[@]}" "$ADMIN_USER@$IP" true; then
  echo "OK: $ADMIN_USER@$IP works with the key; $LOGIN login is now refused by design."
else
  pd_die "key login as $ADMIN_USER failed. Use the provider console (infra/break-glass.sh console) to check sshd and the host firewall."
fi
echo "Next: DNS (python infra/dns/cloudflare-dns.py apply --from-provider), Headscale join (infra/README.md step 4)."
echo "STATE.md: | $(date +%F) | 01 | first boot (existing server) | done | infra/cloud-init.yaml applied to $HOSTNAME_ ($IP) by bootstrap-existing.sh; $ADMIN_USER key login verified |"
