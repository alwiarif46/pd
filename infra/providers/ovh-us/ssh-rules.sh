#!/usr/bin/env bash
# infra/providers/ovh-us/ssh-rules.sh - print every ingress rule of [infra] security_group that covers
# TCP 22, one per line ("<id><TAB><summary>"); nothing printed = no SSH rule. Read-only.
# Verb `ssh-rules` (infra/ssh-rules.sh; plan 01 check 3). Exit 0 = read, 2 = could not read.
# Common flags: --dry-run  --tenant PATH  --secrets PATH  -h
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
if (( PD_DRY_RUN )); then
  echo "[dry-run] openstack security group show $(tenant_get infra.security_group) -f json | ostool.py sg-ssh-rules" >&2
  exit 0
fi
load_secrets
os_env
os_have_any_cred || exit 2
pd_find_python
sg_json="$(openstack security group show "$(tenant_get infra.security_group)" -f json)" || exit 2
"$PD_PY" "$(pd_native_path "$SCRIPT_DIR/ostool.py")" sg-ssh-rules <<<"$sg_json"
