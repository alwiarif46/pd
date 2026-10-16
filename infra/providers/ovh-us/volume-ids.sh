#!/usr/bin/env bash
# infra/providers/ovh-us/volume-ids.sh - print "data <uuid>" and "backup <uuid>" for the [volumes]
# names (OpenStack Cinder volume UUIDs; the server sees them in /dev/disk/by-id). Read-only.
# Verb `volume-ids` (infra/volume-ids.sh; used by identify-volumes.sh --from-provider and new-tenant.sh).
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
if (( PD_DRY_RUN )); then printf 'data <data-uuid>\nbackup <backup-uuid>\n'; exit 0; fi
load_secrets
os_env
os_check_project
for role in data backup; do
  name="$(tenant_get "volumes.${role}_name")"
  id="$(openstack volume show "$name" -f value -c id | tr -d '\r')" || pd_die "openstack volume show $name failed"
  [[ -n "$id" ]] || pd_die "volume $name has no id"
  printf '%s %s\n' "$role" "$id"
done
