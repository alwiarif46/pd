#!/usr/bin/env bash
# infra/tests/run-tests.sh - offline tests for PD's infrastructure scripts (port of Drive PR #3's
# infra/tests/run-tests.sh, minus the Nextcloud acceptance checks).
#
# Covers infra/providers/*, the infra/*.sh dispatchers, infra/lib/*, infra/render-cloud-init.py,
# infra/server/host-firewall.*, infra/luks/luks-common.sh and infra/dns/cloudflare-dns.py. It runs the REAL
# scripts against fakes: a fake `openstack` CLI (ops/tests/fakes/openstack), a fake Hetzner API
# (infra/tests/fakes/hcloud_fake.py, reached through PD_HCLOUD_API on 127.0.0.1), a fake Cloudflare API
# (PD_CLOUDFLARE_API) and a fake `ssh`. No network, no root, nothing outside a temp dir. It never runs a
# command that formats, attaches or mounts a disk, and never calls refresh-cloudflare.
#
# Usage: bash infra/tests/run-tests.sh        exit 0 = all pass (SKIP lines are cases that need root, nft or a tool
#                                             this machine lacks; CI runs them)
# On Windows run it from Git Bash (the bash in System32 is WSL).
# shellcheck disable=SC2015  # test harness: A && ok || bad is intentional
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../ops/tests/lib.sh
. "$HERE/../../ops/tests/lib.sh"
harness_init "$(cd "$HERE/../.." && pwd)"
FAKES="$REPO/ops/tests/fakes"
guard_fakes
guard_no_luksformat

APPSECRET="appcred-SECRET-value-9f8e7d6c"
HOST="$("$PY" infra/lib/tenant.py get tenant.hostname)"
KEYNAME="$("$PY" infra/lib/tenant.py get tenant.ssh_key_name)"

setup() {
  S="$TMP/$1"; rm -rf "$S"; mkdir -p "$S"
  export FAKE_CALLS="$S/calls" FAKE_OS_STATE="$S/os.json" PATH="$FAKES:$ORIG_PATH" PD_SECRETS="$S/secrets.env" TMPDIR="$S"
  unset FAKE_OS_FAIL FAKE_OS_PORT_SECURITY OS_CLOUD OS_APPLICATION_CREDENTIAL_ID OS_APPLICATION_CREDENTIAL_SECRET PD_TENANT PD_ETC PD_HCLOUD_API PD_CLOUDFLARE_API HCLOUD_TOKEN
  : >"$FAKE_CALLS"
  # a throwaway ed25519 key made for this test run only (deleted with the temp dir)
  ssh-keygen -q -t ed25519 -N "" -C t@test -f "$S/key" >/dev/null 2>&1 \
    || printf 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIfake t@test\n' >"$S/key.pub"
  printf 'OS_APPLICATION_CREDENTIAL_ID=appcred-id-123\nOS_APPLICATION_CREDENTIAL_SECRET=%s\nSSH_PUBKEY_PATH=%s\nADMIN_IP=93.184.216.34\n' "$APPSECRET" "$(np "$S/key.pub")" >"$S/secrets.env"
  # shellcheck disable=SC2016  # a literal $6$ crypt hash, not an expansion
  PDADMIN_HASH='$6$saltsalt$'"$(printf '%086d' 0 | tr 0 a)"; export PDADMIN_HASH
}
np() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }  # native path for python.exe
calls() { cat "$FAKE_CALLS"; }
state() { "$PY" -c "import json,sys; d=json.load(open(sys.argv[2])); print(eval(sys.argv[1]))" "$1" "$(np "$FAKE_OS_STATE")"; }

# ------------------------------------------------------------------ tenant file coverage
# Every tenant key a script reads WITHOUT a default must exist in config/tenant.toml (and in the example tenants).
"$PY" - "$REPO" >"$TMP/keys.txt" 2>&1 <<'PYEOF'
import re, sys, tomllib
from pathlib import Path
repo = Path(sys.argv[1])
pat = re.compile(r'\b(?:tenant_get|tget|tget_list)\s+"?([a-z_][a-z0-9_]*(?:\.[a-z0-9_]+)+)"?([ \t]+[^\s)|;&<>]+)?')
need = {}
for p in list((repo / "infra").rglob("*.sh")) + list((repo / "ops").rglob("*.sh")):
    rel = p.relative_to(repo).as_posix()
    if "/tests/" in rel:
        continue
    for line in p.read_text(encoding="utf-8").splitlines():
        if line.lstrip().startswith("#"):
            continue
        for m in pat.finditer(line):
            if m.group(2):      # a second argument = a default
                continue
            need.setdefault(m.group(1), rel)
missing = []
for name in ("config/tenant.toml", "config/tenants/hetzner.example.toml", "config/tenants/ovh-us.example.toml"):
    data = tomllib.loads((repo / name).read_text(encoding="utf-8"))
    for key, where in sorted(need.items()):
        node = data
        for part in key.split("."):
            node = node.get(part) if isinstance(node, dict) else None
            if node is None:
                break
        if node is None:
            missing.append(f"{name}: {key} (read by {where})")
print("\n".join(missing))
sys.exit(1 if missing else 0)
PYEOF
if [[ $? == 0 ]]; then ok "every tenant key read without a default exists in config/tenant.toml and the example tenants"; else bad "tenant keys missing" "$(cat "$TMP/keys.txt")"; fi

# @@SECTION provider-ovh (commit 4)

# ------------------------------------------------------------------ cloud-init + host firewall
setup render
out="$("$PY" infra/render-cloud-init.py --out "$S/ud.yaml" 2>&1)"; rc=$?
[[ $rc == 0 ]] && grep -q 'table inet pd_fw' "$S/ud.yaml" && grep -q 'bootstrap_ssh4, "{ 93.184.216.34 timeout 6h }"' "$S/ud.yaml" \
  && ! grep -qE '__PD_[A-Z0-9_]+__' "$S/ud.yaml" && ok "rendered cloud-init: host firewall + timed ADMIN_IP element, no tokens left" || bad "render" "$out"
grep -q 'enable, --now, pd-host-firewall.service' "$S/ud.yaml" && ok "rendered cloud-init enables the firewall unit" || bad "unit not enabled"
grep -q 'set cloudflare4' "$S/ud.yaml" && grep -q 'set cloudflare6' "$S/ud.yaml" && grep -q 'tcp dport 443 ip saddr @cloudflare4 accept' "$S/ud.yaml" \
  && ! grep -qE 'dport (\{ *)?80\b' "$S/ud.yaml" && ok "rendered cloud-init: Cloudflare sets, 443 from Cloudflare only, no port 80" || bad "cloudflare sets / port 80 in cloud-init"
grep -q 'path: /etc/pd/cloudflare-ips.txt' "$S/ud.yaml" && ok "rendered cloud-init carries /etc/pd/cloudflare-ips.txt" || bad "cloudflare list not in cloud-init"
grep -q -- '- borgbackup' "$S/ud.yaml" && grep -q -- '- rclone' "$S/ud.yaml" && ! grep -qE '^ +- (python3-)?certbot|vm.max_map_count' "$S/ud.yaml" \
  && ok "cloud-init packages: borgbackup + rclone, no certbot, no vm.max_map_count" || bad "cloud-init packages"
grep -q 'AllowUsers pdadmin' "$S/ud.yaml" && grep -q '/etc/pd' "$S/ud.yaml" && ! grep -qiE 'sdrive|sdadmin' "$S/ud.yaml" && ok "cloud-init: pdadmin, /etc/pd, no sdrive names" || bad "cloud-init names"
sed -i 's/^ADMIN_IP=.*/ADMIN_IP=10.1.2.3/' "$S/secrets.env"
out="$("$PY" infra/render-cloud-init.py --out "$S/ud2.yaml" 2>&1)"; rc=$?
[[ $rc != 0 ]] && grep -q 'not a public address' <<<"$out" && ok "render refuses a private ADMIN_IP" || bad "private ADMIN_IP rendered"
out="$("$PY" infra/render-cloud-init.py --dry-run 2>&1)"; rc=$?
[[ $rc == 0 ]] && grep -q 'YAML parsed OK' <<<"$out" && ok "render-cloud-init --dry-run validates the template" || bad "render dry-run" "$out"

setup fw
bash infra/server/host-firewall.sh render >"$S/fw.nft" 2>"$S/fw.err"; rc=$?
[[ $rc == 0 ]] && grep -q 'tcp dport 443 ip6 saddr @cloudflare6 accept' "$S/fw.nft" && ! grep -qE 'dport (\{ *)?80\b' "$S/fw.nft" && grep -q 'elements = { 173.245.48.0/20' "$S/fw.nft" \
  && ok "host-firewall.sh render: 443 from the Cloudflare sets, no port 80" || bad "fw render" "$(cat "$S/fw.err")"
sed 's/^cloudflare_only = true/cloudflare_only = false/' config/tenant.toml >"$S/open.toml"
bash infra/server/host-firewall.sh render --tenant "$S/open.toml" >"$S/open.nft" 2>&1
grep -qE '^\s*tcp dport 443 accept' "$S/open.nft" && ! grep -q '@cloudflare4 accept' "$S/open.nft" && ok "cloudflare_only = false opens 443 to all (still no port 80)" || bad "cloudflare_only false" "$(cat "$S/open.nft")"
sed 's/^admin_ssh_cidrs = \[\]/admin_ssh_cidrs = ["93.184.216.34", "2001:4860:4860::8888"]/' config/tenant.toml >"$S/adm.toml"
bash infra/server/host-firewall.sh render --tenant "$S/adm.toml" >"$S/adm.nft" 2>&1
grep -q 'elements = { 93.184.216.34/32 }' "$S/adm.nft" && grep -q 'elements = { 2001:4860:4860::8888/128 }' "$S/adm.nft" && ok "admin_ssh_cidrs fill admin_ssh4 / admin_ssh6" || bad "admin ssh cidrs" "$(grep -n admin_ssh "$S/adm.nft")"
sed 's/^admin_ssh_cidrs = \[\]/admin_ssh_cidrs = ["10.0.0.5"]/' config/tenant.toml >"$S/adm2.toml"
bash infra/server/host-firewall.sh render --tenant "$S/adm2.toml" >/dev/null 2>"$S/adm2.err" && bad "private admin_ssh_cidrs accepted" || ok "a private address in admin_ssh_cidrs is refused"
mkdir -p "$S/etc"
try_list() { # try_list NAME CONTENT: render with a replacement Cloudflare list in PD_ETC; must fail
  printf '%b' "$2" >"$S/etc/cloudflare-ips.txt"
  if PD_ETC="$S/etc" bash infra/server/host-firewall.sh render >"$S/o.nft" 2>"$S/o.err"; then bad "host-firewall render accepted $1"; else ok "host-firewall render refuses $1"; fi
}
try_list "an empty Cloudflare list" "# nothing here\n"
try_list "a list with only IPv4" "173.245.48.0/20\n"
try_list "an invalid entry" "999.1.1.1/20\n2400:cb00::/32\n"
try_list "a default route" "0.0.0.0/0\n2400:cb00::/32\n"
try_list "a private range" "10.0.0.0/8\n2400:cb00::/32\n"
out="$(bash infra/server/host-firewall.sh apply --dry-run 2>&1)"; rc=$?
[[ $rc == 0 ]] && grep -q 'nft -c -f' <<<"$out" && grep -q 'no port 80' <<<"$out" && ok "host-firewall.sh apply --dry-run" || bad "host-firewall dry-run" "$out"
out="$(bash infra/server/host-firewall.sh allow-ssh --ip 192.168.1.4 --dry-run 2>&1)"; rc=$?
[[ $rc != 0 ]] && ok "host-firewall allow-ssh refuses a private IP" || bad "allow-ssh private"
out="$(bash infra/server/host-firewall.sh refresh-cloudflare --dry-run 2>&1)"; rc=$?
[[ $rc == 0 ]] && ! grep -q '^curl ' "$FAKE_CALLS" && ok "refresh-cloudflare --dry-run prints the fetch and makes no call" || bad "refresh-cloudflare dry-run" "$out"
if command -v unshare >/dev/null 2>&1 && command -v nft >/dev/null 2>&1 && unshare -rn nft -c -f "$S/fw.nft" >/dev/null 2>&1; then
  unshare -rn sh -c "nft -f '$S/fw.nft' && nft -f '$S/fw.nft' && nft add element inet pd_fw bootstrap_ssh4 '{ 203.0.113.9 timeout 1h }' && nft list table inet pd_fw" >"$S/nft.txt" 2>&1 \
    && grep -q 'policy drop' "$S/nft.txt" && ! grep -q 'flush ruleset' infra/server/host-firewall.nft && ok "rendered ruleset loads twice in nft (netns), timed element accepted" || bad "nft load" "$(cat "$S/nft.txt")"
  grep -q 'iifname "br-\*" ip daddr 169.254.169.254 .*drop' "$S/nft.txt" && grep -q 'ip daddr 169.254.169.254 meta skuid != 0 .*reject' "$S/nft.txt" \
    && ok "metadata service closed to containers (forward) and non-root (output)" || bad "metadata rules" "$(cat "$S/nft.txt")"
  unshare -rn sh -c "iptables-nft -N DOCKER-USER && iptables-nft -A FORWARD -j DOCKER-USER && nft -f '$S/fw.nft' && nft list tables" >"$S/nft2.txt" 2>&1 \
    && grep -q 'table ip filter' "$S/nft2.txt" && grep -q 'table inet pd_fw' "$S/nft2.txt" && ok "loads beside an iptables-nft (Docker-style) filter table" || skip "iptables-nft coexistence ($(head -1 "$S/nft2.txt"))"
else
  skip "nft load tests (needs Linux with nft and unshare -rn; CI runs them)"
fi

# @@SECTION luks-byid (commit 5)
# @@SECTION dns (commit 6)

# ------------------------------------------------------------------ provider layer
# @@SECTION test-providers (commit 4)

# ------------------------------------------------------------------ static
mapfile -t SH < <(find infra ops -name '*.sh' -not -path '*/node_modules/*')
badsyntax=""
for f in "${SH[@]}"; do bash -n "$f" 2>"$TMP/syn.txt" || badsyntax+="$f: $(head -1 "$TMP/syn.txt")"$'\n'; done
[[ -z "$badsyntax" ]] && ok "bash -n on every infra/ and ops/ script (${#SH[@]} files)" || bad "bash -n" "$badsyntax"
if command -v shellcheck >/dev/null 2>&1; then
  if shellcheck -S warning -x -P SCRIPTDIR "${SH[@]}" >"$TMP/sc.txt" 2>&1; then ok "shellcheck clean (infra, ops)"; else bad "shellcheck" "$(head -20 "$TMP/sc.txt")"; fi
else
  skip "shellcheck not installed"
fi
"$PY" - <<'PYEOF' && ok "every infra/ and ops/ Python file compiles" || bad "python syntax"
import sys
from pathlib import Path
bad = []
for root in ("infra", "ops"):
    for p in Path(root).rglob("*.py"):
        try:
            compile(p.read_text(encoding="utf-8"), str(p), "exec")
        except SyntaxError as exc:
            bad.append(f"{p}: {exc}")
print("\n".join(bad))
sys.exit(1 if bad else 0)
PYEOF

summary
