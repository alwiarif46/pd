#!/usr/bin/env bash
# infra/providers/hetzner/ssh-rules.sh - print the [infra.hetzner] firewall rules that cover TCP 22, one
# per line; nothing = none (plan 01 check 3). Read-only. Exit 0 = read, 2 = could not read.
# Common flags: --dry-run  --tenant PATH  --secrets PATH  -h
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/hz-common.sh"
usage() { hz_usage "${BASH_SOURCE[0]}"; }
pd_parse_args "$@"
(( ${#PD_REST[@]} == 0 )) || pd_die "unknown argument: ${PD_REST[0]}"
if (( PD_DRY_RUN )); then echo "[dry-run] would list the TCP 22 rules of the Hetzner firewall" >&2; exit 0; fi
hz_init
hz_py ssh-rules || exit 2
