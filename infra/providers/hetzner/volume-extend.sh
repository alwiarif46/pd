#!/usr/bin/env bash
# infra/providers/hetzner/volume-extend.sh - plan 01 on Hetzner: grow a volume online
# (billable; never shrinks). Then on the server: sudo infra/luks/grow-volume.sh --volume <role>.
# Usage: infra/volume-extend.sh --volume data|backup --size GB [--dry-run | --confirm-purchase]
# Common flags: --tenant PATH  --secrets PATH  -h
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/hz-common.sh"
usage() { hz_usage "${BASH_SOURCE[0]}"; }
pd_parse_args "$@"
hz_init
[[ "$(provider_storage)" == volumes ]] || pd_die "[infra] storage = root-container: grow on the server with infra/luks/grow-volume.sh --volume <role> --size <GB>"
args=(volume-extend)
(( PD_DRY_RUN )) && args+=(--dry-run)
hz_py "${args[@]}" ${PD_REST[@]+"${PD_REST[@]}"}
