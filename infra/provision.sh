#!/usr/bin/env bash
# infra/provision.sh - create or adopt PD server, its disks and provider firewall (plan 01)
# Dispatcher (Drive D-146): runs infra/providers/<[infra] provider>/provision.sh with the same
# arguments. The adapter documents its own flags: bash infra/provision.sh --help
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/tenant.sh
. "$SCRIPT_DIR/lib/tenant.sh"
# shellcheck source=lib/provider.sh
. "$SCRIPT_DIR/lib/provider.sh"
provider_pretenant "$@"
provider_dispatch provision "$@"
