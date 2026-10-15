#!/usr/bin/env bash
# infra/firewall-temp-ssh.sh - temporary TCP 22 rule on the provider firewall (plan 01, steps 2-3)
# Dispatcher (Drive D-146): runs infra/providers/<[infra] provider>/firewall-temp-ssh.sh with the same
# arguments. The adapter documents its own flags: bash infra/firewall-temp-ssh.sh --help
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/tenant.sh
. "$SCRIPT_DIR/lib/tenant.sh"
# shellcheck source=lib/provider.sh
. "$SCRIPT_DIR/lib/provider.sh"
provider_pretenant "$@"
provider_dispatch firewall-temp-ssh "$@"
