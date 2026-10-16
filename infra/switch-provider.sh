#!/usr/bin/env bash
# infra/switch-provider.sh - move a running PD to another hosting provider (mirrors Drive D-149).
#
# The new provider is a second tenant file: a copy of the current one with [infra] provider (and that
# adapter's section) changed. The data moves the way a real restore does (ops/restore-drill/
# restore-runbook.md: new server, pull the encrypted off-site copy from B2, restore the database), so every
# monthly restore drill also rehearses a provider move. Nothing here deletes the old server.
#
# Phases (run in this order; each prints what it does first, and --dry-run shows everything):
#   plan     --to NEW.toml       check both tenant files and print the full ordered checklist
#   build    --to NEW.toml       provision the new server (infra/provision.sh --confirm-purchase); for the ssh
#                                adapter (hand-ordered box, host firewall only) also apply cloud-init
#                                (bootstrap-existing.sh). A server created by the provider already ran it.
#   cutover  --to NEW.toml       point DNS at the new server (cloudflare-dns.py apply --from-provider)
# The server-side middle (base system, B2 pull, restore, live files, checks) is printed by `plan` with exact
# commands: it needs the vault passphrases and a human watching, like a real restore.
#
# Checks before anything runs: the two files are different, name the same tenant id, domain, hostname,
# backup bucket and crypt prefix (the new server must restore THIS tenant's B2 copy), and the target
# adapter exists and supports the chosen storage. Billable or visible steps need --confirm.
#
# Usage:
#   infra/switch-provider.sh plan    --to config/tenants/<new>.toml [--tenant CURRENT.toml]
#   infra/switch-provider.sh build   --to config/tenants/<new>.toml --confirm [--secrets NEW.env]
#   infra/switch-provider.sh cutover --to config/tenants/<new>.toml --confirm [--secrets NEW.env]
# Common flags: --dry-run  --tenant PATH (the CURRENT tenant, default config/tenant.toml)  --secrets PATH  -h
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/tenant.sh
. "$SCRIPT_DIR/lib/tenant.sh"
# shellcheck source=lib/provider.sh
. "$SCRIPT_DIR/lib/provider.sh"
usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }

PHASE="" TO="" CONFIRM=0
pd_parse_args "$@"
set -- ${PD_REST[@]+"${PD_REST[@]}"}
while (( $# )); do
  case "$1" in
    plan | build | cutover) [[ -z "$PHASE" ]] || pd_die "one phase at a time"; PHASE="$1" ;;
    --to) TO="${2:?--to needs the new tenant file}"; shift ;;
    --confirm) CONFIRM=1 ;;
    *) pd_die "unknown argument: $1 (see --help)" ;;
  esac
  shift
done
[[ -n "$PHASE" ]] || { usage; pd_die "phase required: plan | build | cutover"; }
[[ -n "$TO" && -f "$TO" ]] || pd_die "--to must name the new tenant file (a copy of the current one with [infra] provider changed)"
CUR="${PD_TENANT:-$PD_REPO_ROOT/config/tenant.toml}"
[[ -f "$CUR" ]] || pd_die "current tenant file not found: $CUR"
[[ "$(cd "$(dirname "$CUR")" && pwd)/$(basename "$CUR")" != "$(cd "$(dirname "$TO")" && pwd)/$(basename "$TO")" ]] \
  || pd_die "--to names the current tenant file itself"

# tv FILE KEY [default]: a value from either tenant file
tv() { PD_TENANT="$1" tenant_get "$2" ${3+"$3"}; }

for k in tenant.id tenant.domain tenant.hostname backup.bucket backup.crypt_prefix; do
  a="$(tv "$CUR" "$k")"; b="$(tv "$TO" "$k")"
  [[ "$a" == "$b" ]] || pd_die "$k differs ('$a' vs '$b'): the new server must restore THIS tenant's backup under the same names"
done
P_OLD="$(tv "$CUR" infra.provider)"
P_NEW="$(PD_TENANT="$TO" provider_name)"
S_NEW="$(PD_TENANT="$TO" provider_storage)"
[[ "$P_OLD" != "$P_NEW" ]] || pd_warn "both files use provider '$P_OLD' (a move between projects/regions of one provider is fine)"
HOST="$(tv "$CUR" tenant.hostname)"; DOMAIN="$(tv "$CUR" tenant.domain)"
NEWARGS=(--tenant "$TO"); [[ -n "${PD_SECRETS:-}" ]] && NEWARGS+=(--secrets "$PD_SECRETS")
(( PD_DRY_RUN )) && NEWARGS+=(--dry-run)

header() {
  cat <<EOM
Move ${DOMAIN} (${HOST}) from '$P_OLD' to '$P_NEW' ($(PD_TENANT="$TO" provider_conf title)), storage $S_NEW.
Current tenant: $CUR    New tenant: $TO
EOM
}

case "$PHASE" in
  plan)
    header
    cat <<EOM

 0. Before: announce a maintenance window. On the OLD server (admin network):
      sudo docker compose --env-file /opt/pd/.env -f /opt/pd/infra/docker-compose.yml stop api worker
      sudo /opt/pd/infra/scripts/backup.sh          (encrypted Borg dump, then the B2 off-site sync)
      sudo systemctl disable --now pd-backup.timer pd-backup-check.timer
      systemctl is-enabled pd-backup.timer          (must say "disabled": the OLD server must never sync to B2 again;
                                                     two servers syncing one prefix replace each other's copy)
    Check B2 shows a fresh pd/last-offsite-ok (machine= is the OLD server's /etc/machine-id). Copy /opt/pd/.env from
    the vault (it is not in git).
    Put the new provider's key into the secrets file for $TO (never into git).
 1. infra/switch-provider.sh build --to $TO --confirm
      = infra/provision.sh --tenant $TO --confirm-purchase$( [[ "$P_NEW" == ssh ]] && printf '%s' " ; infra/server/bootstrap-existing.sh --tenant $TO --confirm")
    (An EXISTING server at an API provider is only taken over with --adopt-existing; then
     infra/firewall-temp-ssh.sh add --tenant $TO and infra/server/bootstrap-existing.sh --tenant $TO --confirm.)
 2. Base system on the new server: sudo infra/scripts/setup-server.sh, sudo infra/headscale/server-join.sh
      (the old node stays until step 8, so the new one gets a suffixed name: for every --check-host use the
       NEW server's tailnet IP from \`headscale nodes list\`, never $HOST, or the check would test the old server),
      LUKS: $( [[ "$S_NEW" == root-container ]] && printf '%s' "identify-volumes.sh --root-container" || printf '%s' "identify-volumes.sh --from-provider"), create-keyfiles.sh, format-volumes.sh, configure-boot.sh (infra/luks/README.md);
      NEW recovery passphrases into the vault.
 3. Pull the off-site copy: ops/restore-drill/restore-runbook.md section 3 (rclone with the read-only restore key,
      as of last-offsite-ok).
 4. Restore: sudo infra/scripts/deploy.sh (the migrations create the roles pd_app and pd_system), then
      sudo infra/scripts/restore.sh --archive latest --confirm, then set the pd_app password (plan 01).
    Then take the B2 prefix over ONCE (B2's marker names the old machine, so a plain sync is refused):
      sudo infra/scripts/backup.sh --adopt-offsite
      sudo ops/install.sh                          (pd-backup.timer and pd-backup-check.timer on the NEW server)
 5. Copy the live files (plan 01: live files are not in the backups) from the OLD server over the admin network:
      sudo rsync -aHAX --numeric-ids pdadmin@<old tailnet IP>:/mnt/pddata/files/ /mnt/pddata/files/
 6. Check before DNS, over the admin network:
      curl --resolve $DOMAIN:443:<new IPv4> https://$DOMAIN/health -k      (the origin certificate is not publicly trusted)
 7. infra/switch-provider.sh cutover --to $TO --confirm      (DNS A/AAAA -> new server, proxied)
 8. Keep the OLD server stopped but intact for 7 days; then a human deletes it in the old provider's panel
    (it holds LUKS keyfiles: delete its snapshots/backups too) and removes its Headscale node.
 9. Make $TO the tenant file (git mv over config/tenant.toml). The hosting subprocessor changes with the next
    deploy (counsel check: HUMAN-TODO H-09). Log the move in STATE.md.
EOM
    ;;
  build)
    header
    (( CONFIRM || PD_DRY_RUN )) || pd_die "build creates billable resources at '$P_NEW': re-run with --confirm (or --dry-run)"
    pargs=("${NEWARGS[@]}"); (( PD_DRY_RUN )) || pargs+=(--confirm-purchase)
    run bash "$SCRIPT_DIR/provision.sh" "${pargs[@]}"
    if [[ "$(PD_TENANT="$TO" provider_conf firewall)" == host ]]; then
      bargs=("${NEWARGS[@]}"); (( PD_DRY_RUN )) || bargs+=(--confirm)
      echo "== hand-ordered server (no provider API): applying infra/cloud-init.yaml now"
      run bash "$SCRIPT_DIR/server/bootstrap-existing.sh" "${bargs[@]}"
    else
      echo "Server created by the provider from infra/cloud-init.yaml. (If provision ADOPTED an existing one: infra/firewall-temp-ssh.sh add --tenant $TO, then infra/server/bootstrap-existing.sh --tenant $TO --confirm.)"
    fi
    echo "Next: plan steps 2-5 (restore-runbook.md §2-§6 with --tenant $TO), then: infra/switch-provider.sh cutover --to $TO --confirm"
    ;;
  cutover)
    header
    (( CONFIRM || PD_DRY_RUN )) || pd_die "cutover moves $DOMAIN to the new server for every user: re-run with --confirm (or --dry-run)"
    pd_find_python
    # cutover always changes the existing records (old server -> new): cloudflare-dns.py needs --confirm for that
    dnsargs=("${NEWARGS[@]}"); (( CONFIRM )) && dnsargs+=(--confirm)
    run "$PD_PY" "$(pd_native_path "$SCRIPT_DIR/dns/cloudflare-dns.py")" apply --from-provider "${dnsargs[@]}"
    echo "Then: python infra/dns/cloudflare-dns.py check --tenant $TO "
    echo "STATE.md: | $(date +%F) | 01 | provider switch $P_OLD -> $P_NEW | DNS cut over | $DOMAIN -> new server; old server kept stopped until $(date -d '+7 days' +%F 2>/dev/null || echo '+7 days') |"
    ;;
esac
