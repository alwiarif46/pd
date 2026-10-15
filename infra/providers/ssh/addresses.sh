#!/usr/bin/env bash
# infra/providers/ssh/addresses.sh - print "<ipv4> <ipv6>" from [infra.ssh] ipv4/ipv6 (no API to ask;
# the provision probe checks they are really on the box). Verb `addresses`.
# Common flags: --dry-run  --tenant PATH  -h
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../lib/tenant.sh
. "$SCRIPT_DIR/../../lib/tenant.sh"
usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }
pd_parse_args "$@"
(( ${#PD_REST[@]} == 0 )) || pd_die "unknown argument: ${PD_REST[0]}"
[[ "$(tenant_get infra.provider)" == ssh ]] || pd_die "[infra] provider is not 'ssh'"
v6="$(tenant_get infra.ssh.ipv6 "")"
echo "$(tenant_get infra.ssh.ipv4) ${v6:--}"
