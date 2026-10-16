# shellcheck shell=bash
# infra/providers/hetzner/hz-common.sh - shared start of every Hetzner verb script (sourced).
# Loads the tenant + secrets, refuses another [infra] provider, exports HCLOUD_TOKEN for hapi.py (the
# token never appears in argv; tenant.sh registers it for masking) and defines hz_py.
HZ_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../lib/tenant.sh
. "$HZ_DIR/../../lib/tenant.sh"
# shellcheck source=../../lib/provider.sh
. "$HZ_DIR/../../lib/provider.sh"

hz_init() {
  [[ "$(tenant_get infra.provider)" == hetzner ]] || pd_die "[infra] provider is not 'hetzner' (this is infra/providers/hetzner/)"
  pd_find_python
  if (( ! PD_DRY_RUN )); then
    load_secrets
    require_secret HCLOUD_TOKEN
    export HCLOUD_TOKEN
  fi
}

# hz_py SUBCOMMAND [args]: run hapi.py with the tenant file passed through the environment.
hz_py() {
  [[ -n "${PD_TENANT:-}" ]] && export PD_TENANT
  "$PD_PY" "$(pd_native_path "$HZ_DIR/hapi.py")" "$@"
}

hz_usage() { sed -n '2,/^set -euo/p' "$1" | sed '$d' | sed 's/^# \{0,1\}//'; }
