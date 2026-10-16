#!/usr/bin/env bash
# infra/providers/ovh-us/provision.sh
# Implements: docs/plans/01-infrastructure.md section 2 (OVHcloud US Public Cloud resources) and 2.1 (security
# group), with the openstack CLI (python-openstackclient 10.x syntax, checked with --help; DECISIONS
# D-132..D-136). Replaces infra/hetzner/provision.sh.
#
# Creates, check-before-create (safe to run twice; never deletes or shrinks anything):
#   Keypair         tenant.ssh_key_name uploaded from SSH_PUBKEY_PATH (cloud-init installs the key for
#                   the admin user; the keypair is kept for the Control Panel and rescue tooling)
#   Security group  infra.security_group with exactly the s3 ingress rules (IPv4 + IPv6), no
#                   TCP 22; missing rules are added, unexpected ones only reported
#   Server          tenant.hostname, flavor infra.flavor, image infra.image, network infra.public_network
#                   (IPv4 + IPv6), only PD security group (the permissive "default" group is
#                   removed), cloud-init user-data rendered by infra/render-cloud-init.py
#   Volumes         volumes.data_name / backup_name, sizes and Block Storage classes from tenant.toml,
#                   attached, NOT formatted (LUKS comes later, plan 01)
#   Protection      `openstack server lock` on the server; property pd-protected=1 on both volumes
#                   (every pd script refuses to delete a volume carrying it; an attached volume
#                   cannot be deleted anyway). OVH automatic instance backups stay OFF (they would copy
#                   the LUKS keyfiles on the root disk).
#
# Usage:
#   provision.sh --dry-run                       print the plan and every command; no API calls
#   provision.sh --confirm-purchase              create billable resources for real
# Common flags: --tenant PATH  --secrets PATH  -h
# Needs (real run): an OpenStack credential (OS_APPLICATION_CREDENTIAL_ID/_SECRET) and SSH_PUBKEY_PATH and
# ADMIN_IP in the secrets file, the openstack CLI on PATH. The credential must be scoped to PD's
# own Public Cloud project ([infra] project_id when set); the script refuses a project that holds other
# servers.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../lib/tenant.sh
. "$SCRIPT_DIR/../../lib/tenant.sh"
# shellcheck source=../../lib/openstack.sh
. "$SCRIPT_DIR/../../lib/openstack.sh"

usage() {
  sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
}

CONFIRM=0
pd_parse_args "$@"
set -- ${PD_REST[@]+"${PD_REST[@]}"}
while (( $# )); do
  case "$1" in
    --confirm-purchase) CONFIRM=1 ;;
    *) pd_die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done

if (( ! PD_DRY_RUN && ! CONFIRM )); then
  pd_die "refusing to create billable resources without --confirm-purchase (preview with --dry-run)"
fi

# ------------------------------------------------------------------ tenant values
os_provider_check
TENANT_ID="$(tenant_get tenant.id)"
HOSTNAME_="$(tenant_get tenant.hostname)"
SSH_KEY_NAME="$(tenant_get tenant.ssh_key_name)"
REGION="$(tenant_get infra.region)"
PROJECT="$(tenant_get infra.project_name)"
FLAVOR="$(tenant_get infra.flavor)"
IMAGE="$(tenant_get infra.image)"
NETWORK="$(tenant_get infra.public_network)"
SG="$(tenant_get infra.security_group)"
VOL_DATA="$(tenant_get volumes.data_name)"
VOL_DATA_GB="$(tenant_get volumes.data_size_gb)"
VOL_DATA_TYPE="$(tenant_get volumes.data_type)"
VOL_BACKUP="$(tenant_get volumes.backup_name)"
VOL_BACKUP_GB="$(tenant_get volumes.backup_size_gb)"
VOL_BACKUP_TYPE="$(tenant_get volumes.backup_type)"
[[ "$HOSTNAME_" =~ ^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$ ]] || pd_die "tenant.hostname is not a plain host name: $HOSTNAME_"

load_secrets
os_env
SSH_PUBKEY_SHOW="${SSH_PUBKEY_PATH:-<SSH_PUBKEY_PATH>}"

# ------------------------------------------------------------------ plan
cat <<PLAN
Provider        : OVHcloud US Public Cloud (OpenStack), auth $(tenant_get infra.auth_url)
Project         : $PROJECT  (the credential must be scoped to this project only)
Region          : $REGION
Keypair         : $SSH_KEY_NAME  <- $SSH_PUBKEY_SHOW
Security group  : $SG  ingress: tcp/443, icmp, udp/41641 from 0.0.0.0/0 and ::/0
                  NO public SSH (plan 01); egress unrestricted (OpenStack default egress rules)
Server          : $HOSTNAME_  flavor=$FLAVOR image="$IMAGE" network=$NETWORK (IPv4+IPv6)
                  only security group $SG; cloud-init from infra/cloud-init.yaml (rendered outside the repo;
                  includes the host firewall with first-boot SSH from ADMIN_IP for $(tenant_get infra.bootstrap_ssh_hours 6) h)
Volume          : $VOL_DATA  ${VOL_DATA_GB} GB  type $VOL_DATA_TYPE  attach, unformatted
Volume          : $VOL_BACKUP  ${VOL_BACKUP_GB} GB  type $VOL_BACKUP_TYPE  attach, unformatted
Protection      : server lock; volumes property pd-protected=1; automatic instance backups OFF
These resources are billable (hourly).
PLAN

if (( PD_DRY_RUN )); then
  echo "(dry-run: OpenStack is NOT queried; a real run checks each resource by name and only creates what is missing)"
else
  require_secret SSH_PUBKEY_PATH ADMIN_IP
fi

TMPDIR_=""
UNLOCKED_BY_US=0
cleanup() {
  # A run that unlocked the server for a change and then failed must not leave it unlocked.
  if (( UNLOCKED_BY_US )); then
    if openstack server lock "$HOSTNAME_" >/dev/null 2>&1; then
      pd_warn "re-locked $HOSTNAME_ after an interrupted change"
    else
      pd_warn "could not re-lock $HOSTNAME_: run 'openstack server lock $HOSTNAME_' now"
    fi
  fi
  if [[ -n "$TMPDIR_" && -d "$TMPDIR_" ]]; then
    if have shred; then find "$TMPDIR_" -type f -exec shred -u {} + 2>/dev/null || true; fi
    rm -rf "$TMPDIR_"
  fi
}
trap cleanup EXIT

pd_find_python
OSTOOL=("$PD_PY" "$(pd_native_path "$SCRIPT_DIR/ostool.py")")

# ------------------------------------------------------------------ helpers
# exists_server <name>: exact-name match (server list --name is a regex); always false in dry-run
exists_server() {
  (( PD_DRY_RUN )) && return 1
  local out
  out="$(openstack server list --name "^$1\$" -f value -c Name)" || pd_die "openstack server list failed (credential/network?)"
  printf '%s\n' "$out" | tr -d '\r' | grep -Fxq -- "$1"
}
exists_volume() {
  (( PD_DRY_RUN )) && return 1
  local out
  out="$(openstack volume list --name "$1" -f value -c Name)" || pd_die "openstack volume list failed"
  local n
  n="$(printf '%s\n' "$out" | tr -d '\r' | grep -Fxc -- "$1" || true)"
  (( n <= 1 )) || pd_die "$n volumes are named $1; resolve the duplicate in the Control Panel first"
  (( n == 1 ))
}
exists_simple() { # exists_simple <keypair|security group> <name>
  (( PD_DRY_RUN )) && return 1
  # shellcheck disable=SC2086  # $1 is "keypair" or "security group" on purpose
  openstack $1 show "$2" -f value -c name >/dev/null 2>&1
}
# A locked server refuses security-group and volume changes (Nova HTTP 409). Unlock once, before the
# first change; section 5 locks again, and the EXIT trap re-locks if the run dies in between.
unlock_for_change() {
  (( PD_DRY_RUN || UNLOCKED_BY_US )) && return 0
  if [[ "$(openstack server show "$HOSTNAME_" -f json | pyj 'str(d.get("locked")).lower()')" == "true" ]]; then
    run openstack server unlock "$HOSTNAME_"
    UNLOCKED_BY_US=1
  fi
}
wait_volume() { # wait_volume <name> <status>
  local s i
  for i in $(seq 1 60); do
    s="$(openstack volume show "$1" -f value -c status | tr -d '\r')"
    [[ "$s" == "$2" ]] && return 0
    [[ "$s" == error* ]] && pd_die "volume $1 is in state $s"
    sleep 5
  done
  pd_die "volume $1 did not reach '$2' (last: $s) after $((i * 5)) s"
}

# ------------------------------------------------------------------ safety: right project?
os_check_project

# ------------------------------------------------------------------ 1. Keypair
echo "== Keypair: $SSH_KEY_NAME"
if exists_simple keypair "$SSH_KEY_NAME"; then
  echo "exists - skipping"
  have_fp="$(openstack keypair show "$SSH_KEY_NAME" -f value -c fingerprint | tr -d '\r' || true)"
  if have ssh-keygen && [[ -f "$(pd_unix_path "$SSH_PUBKEY_PATH")" ]]; then
    local_fp="$(ssh-keygen -E md5 -lf "$(pd_unix_path "$SSH_PUBKEY_PATH")" 2>/dev/null | awk '{print $2}' | sed 's/^MD5://')" || local_fp=""
    if [[ -n "$have_fp" && "$have_fp" != "$local_fp" ]]; then
      pd_warn "uploaded keypair '$SSH_KEY_NAME' differs from SSH_PUBKEY_PATH (fingerprints differ). Not changing it."
    fi
  fi
else
  run openstack keypair create --public-key "$(pd_native_path "$(pd_unix_path "$SSH_PUBKEY_SHOW")")" "$SSH_KEY_NAME"
fi

# ------------------------------------------------------------------ 2. Security group
echo "== Security group: $SG"
if exists_simple "security group" "$SG"; then
  echo "exists - checking ingress rules against plan 01"
else
  run openstack security group create --description "PD public edge (plan 01): 443/ICMP/41641 only, no SSH, no port 80" "$SG"
fi
if (( PD_DRY_RUN )); then
  missing="$("${OSTOOL[@]}" sg-desired)"
else
  missing="$(openstack security group show "$SG" -f json | "${OSTOOL[@]}" sg-missing)"
fi
while IFS=$'\t' read -r eth proto port remote desc; do
  [[ -n "$eth" ]] || continue
  portarg=(); [[ "$port" != "-" ]] && portarg=(--dst-port "$port")
  run openstack security group rule create --ingress --ethertype "$eth" --protocol "$proto" "${portarg[@]}" \
    --remote-ip "$remote" --description "$desc" "$SG"
done <<<"$missing"
if (( ! PD_DRY_RUN )); then
  if openstack security group show "$SG" -f json | "${OSTOOL[@]}" sg-drift; then
    echo "rules match"
  else
    pd_warn "security group rules differ from the spec (above). Not auto-removing rules on a live group; fix by hand."
  fi
fi

# ------------------------------------------------------------------ 3. Server
echo "== Server: $HOSTNAME_"
if exists_server "$HOSTNAME_"; then
  echo "exists - skipping creation"
else
  [[ -n "$TMPDIR_" ]] || TMPDIR_="$(mktemp -d)"
  USERDATA="$TMPDIR_/user-data.yaml"
  python_render=("$PD_PY" "$(pd_native_path "$SCRIPT_DIR/../../render-cloud-init.py")")
  [[ -n "${PD_TENANT:-}" ]] && python_render+=(--tenant "$(pd_native_path "$PD_TENANT")")
  [[ -n "${PD_SECRETS:-}" ]] && python_render+=(--secrets "$(pd_native_path "$PD_SECRETS")")
  if (( PD_DRY_RUN )); then
    "${python_render[@]}" --dry-run
    USERDATA="<rendered-user-data-file>"
  else
    "${python_render[@]}" --out "$(pd_native_path "$USERDATA")"
    USERDATA="$(pd_native_path "$USERDATA")"
  fi
  # Only PD security group: without --security-group Nova attaches "default", which allows
  # everything on OVH. No --boot-from-volume: the b3 flavors boot from their local NVMe disk.
  run openstack server create \
    --flavor "$FLAVOR" --image "$IMAGE" --network "$NETWORK" \
    --key-name "$SSH_KEY_NAME" --security-group "$SG" \
    --user-data "$USERDATA" \
    --property "pd-tenant=$TENANT_ID" --property pd-role=drive \
    --wait "$HOSTNAME_"
fi
if (( ! PD_DRY_RUN )); then
  srv_json="$(openstack server show "$HOSTNAME_" -f json)"
  sgs="$(printf '%s' "$srv_json" | pyj '",".join(sorted({(g.get("name") if isinstance(g, dict) else str(g)) for g in (d.get("security_groups") or [])}))')"
  [[ ",$sgs," == *",$SG,"* ]] || { unlock_for_change; run openstack server add security group "$HOSTNAME_" "$SG"; }
  if [[ ",$sgs," == *",default,"* ]]; then
    unlock_for_change
    pd_warn "the permissive 'default' security group is attached to $HOSTNAME_: removing it (PD group stays)"
    run openstack server remove security group "$HOSTNAME_" default
  fi
  # Is the group enforced on the public port? (D-135: verify on OVH; the host firewall covers the gap.)
  while read -r port_id; do
    [[ -n "$port_id" ]] || continue
    pse="$(openstack port show "$port_id" -f value -c port_security_enabled | tr -d '\r')"
    if [[ "${pse,,}" != "true" ]]; then
      pd_warn "port $port_id of $HOSTNAME_ has port security DISABLED: security group $SG is NOT enforced there. The host firewall (infra/server/host-firewall.sh) is then the only filter; acceptance check 2 (nmap) decides."
    else
      echo "port $port_id: port security on, group $SG enforced"
    fi
  done < <(openstack port list --server "$HOSTNAME_" -f value -c ID | tr -d '\r')
fi

# ------------------------------------------------------------------ 4. Volumes
ensure_volume() {
  local name="$1" size="$2" vtype="$3" role="$4"
  echo "== Volume: $name (${size} GB, $vtype)"
  if exists_volume "$name"; then
    echo "exists - skipping creation"
    local vj have_type have_size att srv_id
    vj="$(openstack volume show "$name" -f json)"
    have_type="$(printf '%s' "$vj" | pyj 'd.get("type") or ""')"
    have_size="$(printf '%s' "$vj" | pyj 'd.get("size")')"
    [[ "$have_type" == "$vtype" ]] || pd_warn "volume $name has type '$have_type', tenant.toml says '$vtype'"
    (( have_size >= size )) || pd_warn "volume $name is $have_size GB, tenant.toml says $size GB (grow: infra/providers/ovh-us/volume-extend.sh)"
    att="$(printf '%s' "$vj" | pyj '",".join(a.get("server_id", "") for a in (d.get("attachments") or []))')"
    srv_id="$(openstack server show "$HOSTNAME_" -f value -c id | tr -d '\r')"
    if [[ -z "$att" ]]; then
      unlock_for_change
      run openstack server add volume "$HOSTNAME_" "$name"
    elif [[ "$att" != "$srv_id" ]]; then
      pd_die "volume $name is attached to another server ($att)"
    else
      echo "already attached"
    fi
  else
    # No filesystem, no image: the volume stays blank (LUKS is set up in plan 01).
    run openstack volume create --size "$size" --type "$vtype" \
      --property "pd-tenant=$TENANT_ID" --property "pd-role=$role" --property pd-protected=1 \
      "$name"
    (( PD_DRY_RUN )) || wait_volume "$name" available
    unlock_for_change
    run openstack server add volume "$HOSTNAME_" "$name"
  fi
}
ensure_volume "$VOL_DATA" "$VOL_DATA_GB" "$VOL_DATA_TYPE" data
ensure_volume "$VOL_BACKUP" "$VOL_BACKUP_GB" "$VOL_BACKUP_TYPE" backup

# ------------------------------------------------------------------ 5. Protection
echo "== Protection"
if (( PD_DRY_RUN )); then
  run openstack server lock "$HOSTNAME_"
  run openstack volume set --property pd-protected=1 "$VOL_DATA"
  run openstack volume set --property pd-protected=1 "$VOL_BACKUP"
else
  if [[ "$(openstack server show "$HOSTNAME_" -f json | pyj 'str(d.get("locked")).lower()')" != "true" ]]; then
    run openstack server lock "$HOSTNAME_"
    UNLOCKED_BY_US=0
  else
    echo "server already locked"
  fi
  for v in "$VOL_DATA" "$VOL_BACKUP"; do
    if [[ "$(openstack volume show "$v" -f json | "${OSTOOL[@]}" props pd-protected)" != "1" ]]; then
      run openstack volume set --property pd-protected=1 "$v"
    else
      echo "volume $v already marked pd-protected=1"
    fi
  done
fi
echo "Automatic instance backups: keep them OFF in the Control Panel (they copy the root disk with the LUKS keyfiles; plan 01)."

# ------------------------------------------------------------------ summary
echo
echo "== Done"
if (( PD_DRY_RUN )); then
  echo "dry-run finished: nothing was created."
else
  read -r ip4 ip6 < <(openstack server show "$HOSTNAME_" -f json | "${OSTOOL[@]}" addresses "$NETWORK" || true)
  echo "server IPv4 : ${ip4:--}"
  echo "server IPv6 : ${ip6:--}   (verify on the server with: ip -6 addr; OVH may need the IPv6 configured, plan 01)"
  echo "Next: DNS (infra/dns/cloudflare-dns.py apply --from-openstack), then the temporary SSH window (infra/README.md step 4)."
  echo "STATE.md line to paste:"
  echo "| $(date +%F) | 01 | §2 OVH resources | done | $HOSTNAME_ ${ip4:--} / ${ip6:--} ($FLAVOR, $REGION) ensured; sg $SG, volumes $VOL_DATA/$VOL_BACKUP attached unformatted, server locked |"
fi
