# shellcheck shell=bash
# infra/lib/openstack.sh - (adapter ovh-us, D-146) OVHcloud US Public Cloud (OpenStack) helpers for the laptop-side scripts.
# Implements: docs/plans/01-infrastructure.md section 2 (provider = [infra] in config/tenant.toml) and the
# credential rules of Drive D-136 (application credential, never a token in argv).
#
# Source AFTER infra/lib/tenant.sh (needs tenant_get, load_secrets, pd_die, have):
#     . "$SCRIPT_DIR/../lib/openstack.sh"
#     os_provider_check                 # refuses any [infra] provider other than "ovh-us"
#     load_secrets; os_env              # exports OS_* for the openstack CLI (real run only)
#     os_check_project                  # credential must be scoped to [infra] project_id (if set)
#
# Credentials (secrets file, KEY=VALUE, never sourced; see security/secrets-inventory.md):
#   preferred  OS_APPLICATION_CREDENTIAL_ID + OS_APPLICATION_CREDENTIAL_SECRET
#              (Keystone application credential of the project's OpenStack user, created with an
#              expiry; delete it after use, HUMAN-TODO H-35)
#   fallback   OS_USERNAME + OS_PASSWORD + OS_PROJECT_ID (the OpenStack user itself; *verify* that
#              OVHcloud US accepts application credentials, otherwise use this)
# The openstack CLI reads them from the environment, so no secret ever appears on a command line.
# Endpoints: auth URL and region from [infra] (https://auth.cloud.ovh.us/v3, US-EAST-VA-1); the compute,
# network and volume endpoints come from the Keystone service catalog.

OS_PROVIDER_EXPECTED="ovh-us"
# Residency guard (audit LOW-4): the Keystone host must be OVHcloud US's unless the tenant names another
# one on purpose in [infra] auth_host (an operator with its own OVH entity). A typo or an EU/CA endpoint
# would otherwise silently create resources outside the US.
OS_AUTH_HOST_DEFAULT="auth.cloud.ovh.us"

os_provider_check() {
  local p
  p="$(tenant_get infra.provider)"
  [[ "$p" == "$OS_PROVIDER_EXPECTED" ]] \
    || pd_die "[infra] provider = '$p': this step uses the OpenStack (OVHcloud US) adapter only (infra/providers/ovh-us/). Use the provider-neutral entry point (infra/provision.sh, infra/server-addresses.sh, ...) or see docs/plans/01-infrastructure.md section 2."
}

# os_env: export the OS_* variables the openstack CLI needs. Call after load_secrets. Dies when no
# usable credential is present (dry-run: only notes it).
os_env() {
  local auth_url region
  auth_url="$(tenant_get infra.auth_url)"
  region="$(tenant_get infra.region)"
  [[ "$auth_url" =~ ^https://([A-Za-z0-9.-]+)(:[0-9]+)?/v3/?$ ]] || pd_die "[infra] auth_url must be an https Keystone v3 URL, got '$auth_url'"
  local got_host="${BASH_REMATCH[1]}" want_host
  want_host="$(tenant_get infra.auth_host "$OS_AUTH_HOST_DEFAULT")"
  [[ "${got_host,,}" == "${want_host,,}" ]] \
    || pd_die "[infra] auth_url host '$got_host' is not '$want_host' (US residency guard; set [infra] auth_host only if another endpoint is intended)"
  [[ "$region" =~ ^[A-Za-z0-9-]{2,32}$ ]] || pd_die "[infra] region looks wrong: '$region'"
  # A clouds.yaml entry or an OpenRC sourced earlier must not silently win over the tenant values.
  unset OS_CLOUD OS_TOKEN OS_AUTH_TOKEN OS_PROJECT_NAME OS_TENANT_ID OS_TENANT_NAME
  export OS_AUTH_URL="$auth_url" OS_REGION_NAME="$region" OS_IDENTITY_API_VERSION=3 OS_INTERFACE=public
  if [[ -n "${OS_APPLICATION_CREDENTIAL_ID:-}" && -n "${OS_APPLICATION_CREDENTIAL_SECRET:-}" ]]; then
    export OS_AUTH_TYPE=v3applicationcredential OS_APPLICATION_CREDENTIAL_ID OS_APPLICATION_CREDENTIAL_SECRET
    unset OS_USERNAME OS_PASSWORD OS_PROJECT_ID OS_USER_DOMAIN_NAME OS_PROJECT_DOMAIN_NAME
  elif [[ -n "${OS_USERNAME:-}" && -n "${OS_PASSWORD:-}" && -n "${OS_PROJECT_ID:-}" ]]; then
    export OS_AUTH_TYPE=password OS_USERNAME OS_PASSWORD OS_PROJECT_ID
    export OS_USER_DOMAIN_NAME="${OS_USER_DOMAIN_NAME:-Default}"
  elif (( PD_DRY_RUN )); then
    pd_log "note: no OpenStack credential in the secrets file (needed for a real run: OS_APPLICATION_CREDENTIAL_ID/_SECRET)"
    return 0
  else
    pd_die "no OpenStack credential: put OS_APPLICATION_CREDENTIAL_ID and OS_APPLICATION_CREDENTIAL_SECRET (or OS_USERNAME, OS_PASSWORD, OS_PROJECT_ID) in the secrets file (HUMAN-TODO H-01/H-03)"
  fi
  have openstack || pd_die "openstack CLI not found on PATH (pip install python-openstackclient; infra/README.md)"
}

os_have_any_cred() { [[ -n "${OS_APPLICATION_CREDENTIAL_SECRET:-}" || -n "${OS_PASSWORD:-}" ]]; }

# os_check_project: the credential's project must be [infra] project_id when that is set, and the
# project must be dedicated to this PD server: any server whose name is neither the tenant hostname nor a
# drill VM means a wrong (shared) project, so nothing is created or deleted there.
os_check_project() {
  (( PD_DRY_RUN )) && return 0
  local want got host prefix others
  want="$(tenant_get infra.project_id "")"
  got="$(openstack token issue -f value -c project_id)" || pd_die "OpenStack authentication failed (credential expired or wrong auth_url/region?)"
  got="${got%$'\r'}"
  if [[ -n "$want" && "$got" != "$want" ]]; then
    pd_die "the credential is scoped to project $got, not [infra] project_id $want. Use PD project's credential."
  fi
  [[ -n "$want" ]] || pd_warn "[infra] project_id is empty: set it to $got in config/tenant.toml after checking it in the OVHcloud Control Panel"
  host="$(tenant_get tenant.hostname)"
  prefix="$(tenant_get drill.name_prefix pd-drill)"
  others="$(openstack server list -f value -c Name | tr -d '\r' | grep -vFx -- "$host" | grep -v -- "^$prefix-" || true)"
  [[ -z "$others" ]] || pd_die "project $got also holds other servers ($(printf '%s' "$others" | tr '\n' ' ')): PD needs its own Public Cloud project (plan 01 section 2)."
}

