# shellcheck shell=bash
# infra/lib/provider.sh - hosting provider adapters (Drive D-146).
#
# PD runs on one Ubuntu 24.04 server. Everything above that server (LUKS, Docker, the compose stack, nftables,
# Headscale, backups, monitoring) is provider-neutral. What differs per provider lives in one folder:
#
#   infra/providers/<name>/provider.conf   KEY=VALUE manifest (read here, never executed)
#   infra/providers/<name>/<verb>.sh       one script per supported verb
#
# The provider is chosen by ONE tenant value, [infra] provider in config/tenant.toml, and its API key
# lives in the secrets file (never in git). Switching where a NEW server is built is that line plus the
# key; moving a RUNNING PD is infra/switch-provider.sh (backup restore onto the new server, D-149).
#
# Verbs (an adapter declares the ones it implements in provider.conf `verbs=`):
#   provision          create or adopt the server, its disks and its provider firewall (billable)
#   addresses          print "<ipv4> <ipv6>" of PD server ("-" when unknown)
#   firewall-temp-ssh  add / remove / list the temporary TCP 22 rule of the provider firewall
#   ssh-rules          print the provider firewall's ingress rules that cover TCP 22 (empty = none)
#   break-glass        console / status / rescue / unrescue
#   volume-extend      grow a provider volume (billable); root-container storage grows on the server
#   volume-ids         print "data <id>" and "backup <id>" for infra/luks/identify-volumes.sh
#
# provider.conf keys:
#   name=<id>                      must equal the folder name and [infra] provider
#   title=<human name>
#   verbs=<space separated list>
#   storage=volumes|root-container|volumes root-container   storage modes the adapter supports
#   firewall=api|host              api: a provider firewall exists in front of the host firewall
#   billing=hourly|monthly         drives the restore-drill choice (restore drill, ops/restore-drill)
#   api_host=<host>                the only API host the adapter talks to (egress allow-list)
#   subprocessor=<legal name>      the hosting company named in the privacy statement; empty = the tenant
#                                  must set [infra] subprocessor (adapter ssh: the company is the owner's choice)
#
# Public interface (source after infra/lib/tenant.sh):
#   provider_name                  [infra] provider, validated (lowercase id, folder exists)
#   provider_dir [name]            absolute folder of the adapter
#   provider_conf KEY [name]       value from provider.conf ("" when absent)
#   provider_has VERB [name]       true when the adapter implements VERB
#   provider_storage               [infra] storage (default: the adapter's first storage mode),
#                                  validated against the adapter
#   provider_dispatch VERB "$@"    exec infra/providers/<name>/<VERB>.sh "$@" (dies on an unknown verb)
#   provider_subprocessor          legal name of the hosting company: [infra] subprocessor when set, else the
#                                  adapter's provider.conf subprocessor, else dies (deploy.sh exports it to the api)

PD_PROVIDERS_DIR="$PD_INFRA_DIR/providers"
PD_PROVIDER_RE='^[a-z][a-z0-9-]{1,30}$'

provider_name() {
  local p
  p="$(tenant_get infra.provider)"
  [[ "$p" =~ $PD_PROVIDER_RE ]] || pd_die "[infra] provider '$p' is not a provider id (lowercase letters, digits, dashes)"
  [[ -f "$PD_PROVIDERS_DIR/$p/provider.conf" ]] \
    || pd_die "[infra] provider = '$p': no adapter in infra/providers/$p/ (available: $(provider_list | tr '\n' ' '))"
  printf '%s\n' "$p"
}

provider_list() {
  local d
  for d in "$PD_PROVIDERS_DIR"/*/provider.conf; do
    [[ -f "$d" ]] && basename "$(dirname "$d")"
  done
}

provider_dir() {
  local p="${1:-}"
  [[ -n "$p" ]] || p="$(provider_name)"
  printf '%s\n' "$PD_PROVIDERS_DIR/$p"
}

# provider_conf KEY [name]: the manifest is parsed as KEY=VALUE text, never sourced.
provider_conf() {
  local key="$1" p="${2:-}" f line
  f="$(provider_dir "$p")/provider.conf"
  [[ -f "$f" ]] || pd_die "missing $f"
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*# || -z "${line// /}" ]] && continue
    if [[ "${line%%=*}" == "$key" ]]; then
      printf '%s\n' "${line#*=}"
      return 0
    fi
  done <"$f"
  printf '\n'
}

provider_has() {
  local verb="$1" v
  for v in $(provider_conf verbs "${2:-}"); do
    [[ "$v" == "$verb" ]] && return 0
  done
  return 1
}

# provider_storage: "volumes" (separate provider block volumes, D-133) or "root-container" (LUKS
# containers on the root disk, D-147). [infra] storage overrides the adapter's default (its first mode).
provider_storage() {
  local p modes want m
  p="$(provider_name)"
  modes="$(provider_conf storage "$p")"
  [[ -n "$modes" ]] || pd_die "infra/providers/$p/provider.conf has no storage= line"
  want="$(tenant_get infra.storage "")"
  [[ -n "$want" ]] || want="${modes%% *}"
  for m in $modes; do
    if [[ "$m" == "$want" ]]; then printf '%s\n' "$want"; return 0; fi
  done
  pd_die "[infra] storage = '$want' is not supported by provider '$p' (supported: $modes)"
}

provider_dispatch() {
  local verb="$1" p script
  shift
  p="$(provider_name)"
  if ! provider_has "$verb" "$p"; then
    pd_die "provider '$p' ($(provider_conf title "$p")) has no '$verb' step. $(provider_hint "$verb" "$p")"
  fi
  script="$PD_PROVIDERS_DIR/$p/$verb.sh"
  [[ -f "$script" ]] || pd_die "provider '$p' declares '$verb' but $script is missing"
  exec bash "$script" "$@"
}

# provider_subprocessor: the hosting company named in the app's privacy statement (GET /api/about/processing).
# [infra] subprocessor overrides the adapter's own value; the ssh adapter has none, so the tenant must say.
provider_subprocessor() {
  local p v
  p="$(provider_name)"
  v="$(tenant_get infra.subprocessor "")"
  if [[ -z "${v// /}" ]]; then v="$(provider_conf subprocessor "$p")"; fi
  [[ -n "${v// /}" ]] || pd_die "set [infra] subprocessor (the hosting company's legal name) for provider '$p'"
  printf '%s\n' "$v"
}

# What to do instead when an adapter lacks a verb (printed by provider_dispatch).
provider_hint() {
  local verb="$1" p="$2"
  case "$verb" in
    volume-extend) printf '%s' "Root-container storage grows on the server: sudo infra/luks/grow-volume.sh --volume <role> --size <GB>." ;;
    firewall-temp-ssh) printf '%s' "This provider has no API firewall: the host firewall is the only filter (infra/server/host-firewall.sh allow-ssh --ip IP)." ;;
    ssh-rules) printf '%s' "No provider firewall to inspect; the host firewall (infra/server/host-firewall.sh) is the only filter." ;;
    break-glass) printf '%s' "Use the provider's web console for console/rescue access (infra/providers/$p/README.md)." ;;
    *) printf '%s' "See infra/providers/$p/README.md." ;;
  esac
}

# provider_tenant_args: rebuild the common flags for a child script (dispatch keeps "$@" as given;
# this helper is for scripts that call another verb themselves).
provider_tenant_args() {
  PROVIDER_ARGS=()
  [[ -n "${PD_TENANT:-}" ]] && PROVIDER_ARGS+=(--tenant "$PD_TENANT")
  [[ -n "${PD_SECRETS:-}" ]] && PROVIDER_ARGS+=(--secrets "$PD_SECRETS")
  (( PD_DRY_RUN )) && PROVIDER_ARGS+=(--dry-run)
  return 0
}

# provider_pretenant "$@": a dispatcher must know the tenant file before it can pick the adapter, but
# leaves the full argument list to the adapter. Only --tenant is read here; nothing is consumed.
provider_pretenant() {
  while (( $# )); do
    case "$1" in
      --tenant) [[ $# -ge 2 ]] || pd_die "--tenant needs a path"; export PD_TENANT="$2"; shift ;;
      --tenant=*) export PD_TENANT="${1#--tenant=}" ;;
    esac
    shift
  done
  if [[ -n "${PD_TENANT:-}" && ! -f "$PD_TENANT" ]]; then
    pd_die "tenant file not found: $PD_TENANT"
  fi
  return 0
}

# provider_admin_ssh_check HOST NO_CHECK: the guard every `firewall-temp-ssh remove` runs first
# (plan 01): HOST must resolve into the admin network and key-only SSH to it must work,
# otherwise the temporary rule stays (no lockout). NO_CHECK=1 skips it with a warning.
provider_admin_ssh_check() {
  local host="$1" no_check="$2" admin tail_ip
  admin="$(tenant_get server.admin_user)"
  if [[ -n "$host" && "$no_check" == 1 ]]; then pd_die "give either --check-host HOST or --no-check, not both"; fi
  if [[ -z "$host" && "$no_check" != 1 ]]; then
    pd_die "remove needs --check-host <admin-network name or IP of the server> (or an explicit --no-check)"
  fi
  if [[ "$no_check" == 1 ]]; then
    pd_warn "--no-check: NOT verifying admin-network SSH before removing the rule"
    return 0
  fi
  pd_find_python
  if tail_ip="$("$PD_PY" "$(pd_native_path "$PD_LIB_DIR/netutil.py")" tailnet-addr "$host")"; then
    :
  elif (( PD_DRY_RUN )); then
    tail_ip="<tailnet-ip-of-$host>"
    pd_warn "$host does not resolve into the admin network from here (dry-run continues; a real run would refuse)"
  else
    pd_die "refusing: $host must resolve into 100.64.0.0/10 or fd7a:115c:a1e0::/48 (admin network), not a public address. Are you on the tailnet?"
  fi
  echo "checking admin-network SSH: $admin@$host ($tail_ip)"
  run ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new \
    -o HostKeyAlias="$host" "$admin@$tail_ip" true </dev/null \
    || pd_die "admin-network SSH to $host ($tail_ip) failed; keeping the temporary rule so you are not locked out"
}
