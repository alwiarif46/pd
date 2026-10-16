#!/usr/bin/env bash
# infra/break-glass.sh - out-of-band console / rescue access (plan 01)
# Dispatcher (Drive D-146): runs infra/providers/<[infra] provider>/break-glass.sh with the same
# arguments. The adapter documents its own flags: bash infra/break-glass.sh --help
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/tenant.sh
. "$SCRIPT_DIR/lib/tenant.sh"
# shellcheck source=lib/provider.sh
. "$SCRIPT_DIR/lib/provider.sh"
provider_pretenant "$@"
provider_dispatch break-glass "$@"
