#!/usr/bin/env bash
# infra/providers/hetzner/volume-ids.sh - print "data <id>" and "backup <id>" (numeric Hetzner volume
# ids; the server sees /dev/disk/by-id/scsi-0HC_Volume_<id>). Read-only. Only for storage = volumes.
# Common flags: --dry-run  --tenant PATH  --secrets PATH  -h
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/hz-common.sh"
usage() { hz_usage "${BASH_SOURCE[0]}"; }
pd_parse_args "$@"
(( ${#PD_REST[@]} == 0 )) || pd_die "unknown argument: ${PD_REST[0]}"
hz_init
[[ "$(provider_storage)" == volumes ]] || pd_die "[infra] storage = root-container: no provider volumes (use identify-volumes.sh --root-container on the server)"
if (( PD_DRY_RUN )); then printf 'data <data-id>\nbackup <backup-id>\n'; exit 0; fi
hz_py volume-ids
