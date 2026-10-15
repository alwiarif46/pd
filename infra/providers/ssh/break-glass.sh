#!/usr/bin/env bash
# infra/providers/ssh/break-glass.sh - plan 01 without a provider API: prints where the
# provider's web console and rescue system are ([infra.ssh] panel_url) and the rules for using them.
# Usage: infra/break-glass.sh console|status|rescue|unrescue   Common flags: --tenant PATH  -h
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../lib/tenant.sh
. "$SCRIPT_DIR/../../lib/tenant.sh"
usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }
pd_parse_args "$@"
[[ "$(tenant_get infra.provider)" == ssh ]] || pd_die "[infra] provider is not 'ssh'"
panel="$(tenant_get infra.ssh.panel_url "the provider's control panel")"
cat <<EOM
No provider API: break-glass is manual, in $panel.
  console   the provider's VNC/web console; log in as $(tenant_get server.admin_user) with the password-manager password
  rescue    the provider's rescue system. It has NO host firewall and sees the root disk WITH the LUKS keyfiles and
            containers (D-147): only while you watch it, from your own IP, and reboot to normal right after
  status    check the server state in the panel; from the admin network: ssh $(tenant_get server.admin_user)@$(tenant_get tenant.hostname) systemctl is-system-running
Record each use in STATE.md (plan 01).
EOM
