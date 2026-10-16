#!/usr/bin/env bash
# infra/volume-extend.sh - grow a provider block volume (plan 01)
# Dispatcher (Drive D-146): runs infra/providers/<[infra] provider>/volume-extend.sh with the same
# arguments. The adapter documents its own flags: bash infra/volume-extend.sh --help
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/tenant.sh
. "$SCRIPT_DIR/lib/tenant.sh"
# shellcheck source=lib/provider.sh
. "$SCRIPT_DIR/lib/provider.sh"
provider_pretenant "$@"
provider_dispatch volume-extend "$@"
