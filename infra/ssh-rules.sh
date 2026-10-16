#!/usr/bin/env bash
# infra/ssh-rules.sh - print provider firewall ingress rules covering TCP 22 (plan 01 check 3)
# Dispatcher (Drive D-146): runs infra/providers/<[infra] provider>/ssh-rules.sh with the same
# arguments. The adapter documents its own flags: bash infra/ssh-rules.sh --help
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/tenant.sh
. "$SCRIPT_DIR/lib/tenant.sh"
# shellcheck source=lib/provider.sh
. "$SCRIPT_DIR/lib/provider.sh"
provider_pretenant "$@"
provider_dispatch ssh-rules "$@"
