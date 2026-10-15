#!/usr/bin/env bash
# infra/providers/hetzner/addresses.sh - print "<ipv4> <ipv6>" of tenant.hostname (read-only; IPv6 is
# <prefix>::1 of the server's /64). Verb `addresses` (infra/server-addresses.sh).
# Common flags: --dry-run  --tenant PATH  --secrets PATH  -h
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/hz-common.sh"
usage() { hz_usage "${BASH_SOURCE[0]}"; }
pd_parse_args "$@"
(( ${#PD_REST[@]} == 0 )) || pd_die "unknown argument: ${PD_REST[0]}"
hz_init
if (( PD_DRY_RUN )); then echo "<ipv4> <ipv6>"; exit 0; fi
hz_py addresses
