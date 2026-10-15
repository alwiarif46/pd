#!/usr/bin/env bash
# infra/providers/ovh-us/addresses.sh - print "<ipv4> <ipv6>" of tenant.hostname on [infra]
# public_network ("-" for a missing family). Read-only. Verb `addresses` (infra/server-addresses.sh).
# Common flags: --dry-run (prints placeholders, no API call)  --tenant PATH  --secrets PATH  -h
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../lib/tenant.sh
. "$SCRIPT_DIR/../../lib/tenant.sh"
# shellcheck source=../../lib/openstack.sh
. "$SCRIPT_DIR/../../lib/openstack.sh"
usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }
pd_parse_args "$@"
(( ${#PD_REST[@]} == 0 )) || pd_die "unknown argument: ${PD_REST[0]}"
os_provider_check
if (( PD_DRY_RUN )); then echo "<ipv4> <ipv6>"; exit 0; fi
load_secrets
os_env
pd_find_python
openstack server show "$(tenant_get tenant.hostname)" -f json \
  | "$PD_PY" "$(pd_native_path "$SCRIPT_DIR/ostool.py")" addresses "$(tenant_get infra.public_network)"
