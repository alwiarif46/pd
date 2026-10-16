#!/usr/bin/env bash
# infra/server-addresses.sh - print PD server's public '<ipv4> <ipv6>'
# Dispatcher (Drive D-146): runs infra/providers/<[infra] provider>/addresses.sh with the same
# arguments. The adapter documents its own flags: bash infra/server-addresses.sh --help
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/tenant.sh
. "$SCRIPT_DIR/lib/tenant.sh"
# shellcheck source=lib/provider.sh
. "$SCRIPT_DIR/lib/provider.sh"
provider_pretenant "$@"
provider_dispatch addresses "$@"
