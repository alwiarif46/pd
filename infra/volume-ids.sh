#!/usr/bin/env bash
# infra/volume-ids.sh - print the provider volume ids for infra/luks/identify-volumes.sh
# Dispatcher (Drive D-146): runs infra/providers/<[infra] provider>/volume-ids.sh with the same
# arguments. The adapter documents its own flags: bash infra/volume-ids.sh --help
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/tenant.sh
. "$SCRIPT_DIR/lib/tenant.sh"
# shellcheck source=lib/provider.sh
. "$SCRIPT_DIR/lib/provider.sh"
provider_pretenant "$@"
provider_dispatch volume-ids "$@"
