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
CF_PID=""
trap 'kill "${CF_PID:-}" 2>/dev/null; cleanup_tmp' EXIT

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

# ------------------------------------------------------------------ ovh-us adapter (Drive D-132..D-146)
# The ovh-us tests run against config/tenants/ovh-us.example.toml; the production tenant is the ssh adapter.
setup_ovh() { setup "$1"; export PD_TENANT="$REPO/config/tenants/ovh-us.example.toml"; }

# ------------------------------------------------------------------ provision
setup_ovh prov-dry
out="$(bash infra/provision.sh --dry-run 2>&1)"; rc=$?
[[ $rc == 0 && ! -s "$FAKE_CALLS" ]] && ok "provision --dry-run: exit 0, no openstack call" || bad "provision dry-run" "rc=$rc $(head -3 "$FAKE_CALLS")"
grep -q 'security group rule create --ingress --ethertype IPv6 --protocol ipv6-icmp' <<<"$out" && grep -q -- '--flavor b3-16' <<<"$out" \
  && grep -q -- '--type high-speed-gen2' <<<"$out" && grep -q 'server lock' <<<"$out" && ok "provision plan shows rules, flavor, volume types, lock" || bad "provision plan content" "$(tail -20 <<<"$out")"
! grep -q 'dst-port 22 ' <<<"$out" && ok "provision plan has no TCP 22 rule" || bad "plan opens SSH"
out="$(bash infra/provision.sh 2>&1)"; rc=$?
[[ $rc != 0 ]] && grep -q 'confirm-purchase' <<<"$out" && [[ ! -s "$FAKE_CALLS" ]] && ok "provision refuses without --confirm-purchase" || bad "provision without confirm" "rc=$rc"

setup_ovh prov-real
out="$(bash infra/provision.sh --confirm-purchase 2>&1)"; rc=$?
if [[ $rc == 0 ]]; then ok "provision real run (fake project) exit 0"; else bad "provision real run rc=$rc" "$(tail -15 <<<"$out")"; fi
[[ "$(state 'len(d["servers"])')" == 1 && "$(state 'd["servers"][0]["security_groups"]')" == "['sg-pd']" ]] && ok "server created with only sg-pd" || bad "server/security groups" "$(state 'd["servers"]')"
[[ "$(state 'sorted((r["ethertype"],r["protocol"],r["port_range_min"]) for g in d["security_groups"] for r in g["rules"] if r["direction"]=="ingress")' )" == "[('IPv4', 'icmp', None), ('IPv4', 'tcp', 443), ('IPv4', 'udp', 41641), ('IPv6', 'ipv6-icmp', None), ('IPv6', 'tcp', 443), ('IPv6', 'udp', 41641)]" ]] \
  && ok "security group: exactly the 6 ingress rules (443, ICMP, 41641 over IPv4 and IPv6; no 22, no 80)" || bad "security group rules" "$(state 'd["security_groups"]')"
[[ "$(state 'sorted((v["name"],v["size"],v["type"],v["properties"].get("pd-protected"),len(v["attachments"])) for v in d["volumes"])')" == "[('pd-backup', 40, 'classic', '1', 1), ('pd-data', 40, 'high-speed-gen2', '1', 1)]" ]] \
  && ok "volumes: sizes, classes, protected, attached" || bad "volumes" "$(state 'd["volumes"]')"
[[ "$(state 'd["servers"][0]["locked"]')" == True ]] && ok "server locked" || bad "server not locked"
grep -q -- '--user-data' "$FAKE_CALLS" && ! ls "$S"/tmp.* >/dev/null 2>&1 && ok "user-data passed and the rendered file removed" || bad "user-data handling" "$(ls "$S")"
state '"table inet pd_fw" in d["servers"][0].get("user_data","") and "bootstrap_ssh4, \"{ 93.184.216.34 timeout 6h }\"" in d["servers"][0]["user_data"]' | grep -q True \
  && ok "server user-data carries the host firewall + ADMIN_IP bootstrap element" || bad "server user-data content"
! grep -qF -- "$APPSECRET" "$FAKE_CALLS" && ! grep -qF -- "$APPSECRET" <<<"$out" && ok "application credential secret never in argv or output" || bad "secret leaked"
grep -q 'STATE.md line' <<<"$out" && grep -q '203.0.113.50 / 2001:db8::50' <<<"$out" && ok "summary prints IPv4 + IPv6 from Ext-Net" || bad "summary addresses" "$(tail -5 <<<"$out")"
: >"$FAKE_CALLS"
out="$(bash infra/provision.sh --confirm-purchase 2>&1)"; rc=$?
[[ $rc == 0 ]] && ! grep -qE ' (create|add|lock|set) ' "$FAKE_CALLS" && ok "second run creates/changes nothing (idempotent)" || bad "second run not idempotent" "$(grep -E ' (create|add|lock|set) ' "$FAKE_CALLS" | head -3)"
grep -q 'rules match' <<<"$out" && ok "second run: security group drift check passes" || bad "drift check" "$out"

setup_ovh prov-guards
printf '{"project_id":"p-other","servers":[],"volumes":[],"security_groups":[],"keypairs":[],"ports":[]}' >"$FAKE_OS_STATE"
cp config/tenants/ovh-us.example.toml "$S/tenant.toml"; sed -i 's/^project_id     = ""/project_id     = "p-drive"/' "$S/tenant.toml"
out="$(bash infra/provision.sh --confirm-purchase --tenant "$S/tenant.toml" 2>&1)"; rc=$?
[[ $rc != 0 ]] && grep -q 'not \[infra\] project_id p-drive' <<<"$out" && ! grep -q ' create ' "$FAKE_CALLS" && ok "wrong project id refused before any create" || bad "project id guard" "rc=$rc $out"
printf '{"project_id":"p0","servers":[{"id":"x1","name":"other-app-01","security_groups":["default"]}],"volumes":[],"security_groups":[],"keypairs":[],"ports":[]}' >"$FAKE_OS_STATE"
out="$(bash infra/provision.sh --confirm-purchase 2>&1)"; rc=$?
[[ $rc != 0 ]] && grep -q 'needs its own Public Cloud project' <<<"$out" && ok "shared project (other server) refused" || bad "shared project guard" "rc=$rc $out"
printf '{"project_id":"p0","servers":[{"id":"s1","name":"%s","security_groups":["default","sg-pd"],"locked":true,"addresses":{"Ext-Net":["203.0.113.50"]}}],"volumes":[],"security_groups":[],"keypairs":[{"name":"%s","fingerprint":"aa:bb"}],"ports":[{"id":"pt1","server":"s1","port_security_enabled":"False"}]}' "$HOST" "$KEYNAME" >"$FAKE_OS_STATE"
out="$(bash infra/provision.sh --confirm-purchase 2>&1)"; rc=$?
grep -q "server remove security group $HOST default" "$FAKE_CALLS" && ok "permissive default group removed from an existing server" || bad "default group not removed" "$out"
grep -q 'port security DISABLED' <<<"$out" && ok "disabled port security is reported" || bad "port security warning missing"
grep -q "server unlock $HOST" "$FAKE_CALLS" && [[ "$(state 'd["servers"][0]["locked"]')" == True && "$(state 'd["servers"][0]["security_groups"]')" == "['sg-pd']" ]] \
  && ok "locked server: unlocked for the change, default group removed, locked again" || bad "unlock/relock" "$(state 'd["servers"][0]')"
"$PY" - "$FAKE_OS_STATE" <<'PY'
import json, sys; p = sys.argv[1]; d = json.load(open(p))
for v in d["volumes"]: v["attachments"] = []; v["status"] = "available"
json.dump(d, open(p, "w"))
PY
out="$(FAKE_OS_FAIL='server add volume' bash infra/provision.sh --confirm-purchase 2>&1)"; rc=$?
[[ $rc != 0 && "$(state 'd["servers"][0]["locked"]')" == True ]] && grep -q 're-locked' <<<"$out" && ok "a change that fails after the unlock leaves the server locked (EXIT trap)" || bad "relock on failure" "rc=$rc $(tail -3 <<<"$out")"
printf '{"project_id":"p0","servers":[],"volumes":[],"security_groups":[],"keypairs":[],"ports":[]}' >"$FAKE_OS_STATE"
: >"$FAKE_CALLS"; cp config/tenants/ovh-us.example.toml "$S/eu.toml"; sed -i 's#^auth_url .*#auth_url       = "https://keystone.example.net/v3"#' "$S/eu.toml"
out="$(bash infra/provision.sh --confirm-purchase --tenant "$S/eu.toml" 2>&1)"; rc=$?
[[ $rc != 0 ]] && grep -q 'residency guard' <<<"$out" && ! grep -q '^openstack' "$FAKE_CALLS" && ok "auth_url on a non-US Keystone host refused before any call" || bad "auth host guard" "$out"

# ------------------------------------------------------------------ temporary SSH
setup_ovh ssh
bash infra/provision.sh --confirm-purchase >/dev/null 2>&1
out="$(bash infra/firewall-temp-ssh.sh add 2>&1)"; rc=$?
[[ $rc == 0 && "$(state 'sum(1 for g in d["security_groups"] for r in g["rules"] if r["port_range_min"]==22 and r["remote_ip_prefix"]=="93.184.216.34/32")')" == 1 ]] && ok "temp SSH add: one TCP 22 rule from ADMIN_IP/32" || bad "temp ssh add" "$out"
state '[r["description"] for g in d["security_groups"] for r in g["rules"] if r["port_range_min"]==22][0]' | grep -qE 'created=[0-9]{10}' && ok "temp SSH rule carries its creation time" || bad "no created= stamp"
o="$(openstack security group show sg-pd -f json | "$PY" infra/providers/ovh-us/ostool.py sg-drift)"; rc=$?
[[ $rc == 0 ]] && grep -q '^WARN temporary SSH rule still present: .*93.184.216.34/32, age 0.0 h' <<<"$o" && ok "sg-drift warns about the temporary rule with its age (exit 0)" || bad "drift WARN" "rc=$rc $o"
mkdir -p "$S/bin"; printf '#!/usr/bin/env bash\necho "ssh: connect to host x port 22: Connection timed out" >&2; exit 255\n' >"$S/bin/ssh"; chmod +x "$S/bin/ssh"
bash infra/firewall-temp-ssh.sh add >/dev/null 2>&1
[[ "$(state 'sum(1 for g in d["security_groups"] for r in g["rules"] if r["port_range_min"]==22)')" == 1 ]] && ok "temp SSH add twice: no duplicate" || bad "duplicate ssh rule"
out="$(bash infra/firewall-temp-ssh.sh add --ip 10.0.0.5 2>&1)"; rc=$?
[[ $rc != 0 ]] && ok "temp SSH refuses a private source IP" || bad "private IP accepted"
out="$(bash infra/firewall-temp-ssh.sh remove 2>&1)"; rc=$?
[[ $rc != 0 && "$(state 'sum(1 for g in d["security_groups"] for r in g["rules"] if r["port_range_min"]==22)')" == 1 ]] && ok "remove without --check-host refused, rule kept" || bad "remove guard"
out="$(bash infra/firewall-temp-ssh.sh remove --check-host 203.0.113.50 2>&1)"; rc=$?
[[ $rc != 0 ]] && grep -q 'admin network' <<<"$out" && ok "remove refuses a public --check-host" || bad "public check-host accepted" "$out"
out="$(bash infra/firewall-temp-ssh.sh remove --check-host 100.64.0.5 2>&1)"; rc=$?
[[ $rc == 0 ]] && grep -q 'VERIFIED' <<<"$out" && grep -q '^ssh .*pdadmin@100.64.0.5 true' "$FAKE_CALLS" \
  && [[ "$(state 'sum(1 for g in d["security_groups"] for r in g["rules"] if r["port_range_min"]==22)')" == 0 ]] && ok "remove: admin-network SSH checked, rule deleted, verified" || bad "temp ssh remove" "rc=$rc $out"
ing="$(state 'sum(1 for g in d["security_groups"] for r in g["rules"] if r["direction"]=="ingress")')"
[[ "$ing" == 6 ]] && ok "remove keeps the 6 public rules" || bad "remove touched other rules ($ing left)"

# ------------------------------------------------------------------ ostool drift
desired_json="$("$PY" - <<'PY'
import json, subprocess, sys
rows = []
for n, l in enumerate(subprocess.run([sys.executable, "infra/providers/ovh-us/ostool.py", "sg-desired"], capture_output=True, text=True).stdout.splitlines()):
    eth, proto, port, remote, _ = l.split("\t")
    rows.append({"ID": f"r{n}", "IP Protocol": proto, "Ethertype": eth, "IP Range": remote, "Port Range": "" if port == "-" else f"{port}:{port}", "Direction": "ingress"})
rows += [{"ID": "e4", "IP Protocol": None, "Ethertype": "IPv4", "IP Range": None, "Port Range": "", "Direction": "egress"},
         {"ID": "e6", "IP Protocol": None, "Ethertype": "IPv6", "IP Range": None, "Port Range": "", "Direction": "egress"}]
print(json.dumps(rows))
PY
)"
"$PY" infra/providers/ovh-us/ostool.py sg-drift <<<"$desired_json" >/dev/null && ok "ostool sg-drift: desired set = no drift" || bad "drift on desired set"
wide="$("$PY" -c 'import json,sys; r=json.loads(sys.argv[1]); r.append({"ID":"w","IP Protocol":"tcp","Ethertype":"IPv4","IP Range":"0.0.0.0/0","Port Range":"1:1024","Direction":"ingress"}); print(json.dumps(r))' "$desired_json")"
o="$("$PY" infra/providers/ovh-us/ostool.py sg-drift <<<"$wide")"; rc=$?
[[ $rc == 1 ]] && grep -q 'port 22 rule that is not a single-IP' <<<"$o" && ok "ostool sg-drift flags a wide range covering 22" || bad "wide 22 not flagged" "$o"
anyp="$("$PY" -c 'import json,sys; r=json.loads(sys.argv[1]); r.append({"ID":"a","IP Protocol":None,"Ethertype":"IPv4","IP Range":None,"Port Range":"","Direction":"ingress"}); print(json.dumps(r))' "$desired_json")"
"$PY" infra/providers/ovh-us/ostool.py sg-ssh-rules <<<"$anyp" | grep -q '^a' && ok "ostool: an any-protocol ingress rule counts as SSH" || bad "any-protocol rule missed"
[[ "$("$PY" infra/providers/ovh-us/ostool.py addresses Ext-Net <<<'{"addresses":"Ext-Net=198.51.100.4, 2001:db8::4"}')" == "198.51.100.4 2001:db8::4" ]] && ok "ostool addresses: old string format" || bad "addresses string format"

# ------------------------------------------------------------------ volume extend + break-glass
setup_ovh extend
bash infra/provision.sh --confirm-purchase >/dev/null 2>&1; : >"$FAKE_CALLS"
out="$(bash infra/volume-extend.sh --volume data --size 200 2>&1)"; rc=$?
[[ $rc != 0 && ! -s "$FAKE_CALLS" ]] && ok "volume-extend refuses without --confirm-purchase" || bad "extend guard"
out="$(bash infra/volume-extend.sh --volume data --size 20 --confirm-purchase 2>&1)"; rc=$?
[[ $rc == 0 ]] && grep -q 'never shrink' <<<"$out" && ! grep -q 'volume set' "$FAKE_CALLS" && ok "volume-extend never shrinks" || bad "shrink" "$out"
out="$(bash infra/volume-extend.sh --volume data --size 100 --confirm-purchase 2>&1)"; rc=$?
[[ $rc == 0 && "$(state '[v["size"] for v in d["volumes"] if v["name"]=="pd-data"][0]')" == 100 ]] && grep -q 'os-volume-api-version 3.42 volume set --size 100 pd-data' "$FAKE_CALLS" && ok "volume-extend grows online (API 3.42)" || bad "extend" "$out"
export FAKE_OS_FAIL='volume set --size'
out="$(bash infra/volume-extend.sh --volume backup --size 300 --confirm-purchase 2>&1)"; rc=$?
[[ $rc != 0 ]] && grep -q 'Offline procedure' <<<"$out" && ! grep -q 'remove volume' "$FAKE_CALLS" && ok "refused online extend: offline steps printed, nothing detached" || bad "offline fallback" "$out"
unset FAKE_OS_FAIL
grep -q 'openstack server unlock <hostname>' <<<"$out" && grep -q 'openstack server lock <hostname>' <<<"$out" && ok "offline extend steps unlock and re-lock the server" || bad "offline steps lock"
out="$(bash infra/break-glass.sh rescue 2>&1)"; rc=$?
[[ $rc != 0 ]] && ! grep -q 'rescue' "$FAKE_CALLS" && ok "break-glass rescue needs --confirm-reboot" || bad "rescue guard"
"$PY" - "$FAKE_OS_STATE" <<'PY'
import json, sys; p = sys.argv[1]; d = json.load(open(p)); d["ports"][0]["port_security_enabled"] = "False"; json.dump(d, open(p, "w"))
PY
out="$(bash infra/break-glass.sh rescue --confirm-reboot 2>&1)"; rc=$?
[[ $rc != 0 ]] && grep -q 'port security disabled' <<<"$out" && ! grep -qE 'server (unlock|rescue)' "$FAKE_CALLS" && ok "rescue refused when port security is off" || bad "rescue port security" "$out"
"$PY" - "$FAKE_OS_STATE" <<'PY'
import json, sys; p = sys.argv[1]; d = json.load(open(p)); d["ports"][0]["port_security_enabled"] = "True"
g = [g for g in d["security_groups"] if g["name"] == "sg-pd"][0]
g["rules"].append({"id": "wide22", "direction": "ingress", "ethertype": "IPv4", "protocol": "tcp", "port_range_min": 22, "port_range_max": 22, "remote_ip_prefix": "0.0.0.0/0"})
json.dump(d, open(p, "w"))
PY
out="$(bash infra/break-glass.sh rescue --confirm-reboot 2>&1)"; rc=$?
[[ $rc != 0 ]] && grep -q 'TCP 22 rules other than' <<<"$out" && ! grep -q 'server rescue' "$FAKE_CALLS" && ok "rescue refused while a wide TCP 22 rule exists" || bad "rescue wide rule" "$out"
"$PY" - "$FAKE_OS_STATE" <<'PY'
import json, sys; p = sys.argv[1]; d = json.load(open(p))
g = [g for g in d["security_groups"] if g["name"] == "sg-pd"][0]
g["rules"] = [r for r in g["rules"] if r["id"] != "wide22"] + [{"id": "adm22", "direction": "ingress", "ethertype": "IPv4", "protocol": "tcp", "port_range_min": 22, "port_range_max": 22, "remote_ip_prefix": "93.184.216.34/32"}]
json.dump(d, open(p, "w"))
PY
out="$(bash infra/break-glass.sh rescue --confirm-reboot 2>&1)"; rc=$?
[[ $rc == 0 && "$(state 'd["servers"][0]["status"]')" == RESCUE && "$(state 'd["servers"][0]["locked"]')" == True ]] && grep -q 'DO NOT LEAVE RESCUE RUNNING' <<<"$out" \
  && ok "rescue with only the admin-IP rule: in RESCUE and locked again, warning printed" || bad "rescue ok case" "rc=$rc $out"
out="$(bash infra/break-glass.sh status 2>&1)"
grep -q 'is in RESCUE mode' <<<"$out" && ok "status warns while rescue runs" || bad "status rescue warning" "$out"
out="$(bash infra/break-glass.sh unrescue 2>&1)"; rc=$?
[[ $rc == 0 && "$(state 'd["servers"][0]["status"]')" == ACTIVE && "$(state 'd["servers"][0]["locked"]')" == True ]] && ok "unrescue: ACTIVE and locked" || bad "unrescue" "$out"
"$PY" - "$FAKE_OS_STATE" <<'PY'
import json, sys; p = sys.argv[1]; d = json.load(open(p)); d["servers"][0]["locked"] = False; json.dump(d, open(p, "w"))
PY
out="$(bash infra/break-glass.sh console 2>&1)"
grep -q 'is UNLOCKED' <<<"$out" && ok "console warns about an unlocked server" || bad "unlocked warning" "$out"
out="$(bash infra/break-glass.sh console 2>&1)"
grep -q "console url show --novnc $HOST" "$FAKE_CALLS" && ok "break-glass console prints the noVNC URL" || bad "console"



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

# ------------------------------------------------------------------ cloudflare-dns.py (fake Cloudflare API)
CFTOKEN="cf-fake-token-$(printf '%030d' 5)"
CF_PID=""
start_cf() { # start_cf [SEED_RECORDS_JSON]
  [[ -n "$CF_PID" ]] && { kill "$CF_PID" 2>/dev/null; wait "$CF_PID" 2>/dev/null; }
  printf '{"zone":{"id":"z1","name":"shaavir.com"},"records":%s}' "${1:-[]}" >"$S/cf.json"; : >"$S/cf.calls"; rm -f "$S/cf.port"
  "$PY" infra/tests/fakes/cloudflare_fake.py "$(np "$S/cf.json")" "$(np "$S/cf.calls")" "$(np "$S/cf.port")" "$CFTOKEN" </dev/null >/dev/null 2>&1 &
  CF_PID=$!
  local _; for _ in $(seq 1 50); do [[ -s "$S/cf.port" ]] && break; sleep 0.1; done
  export PD_CLOUDFLARE_API="http://127.0.0.1:$(cat "$S/cf.port")/client/v4"
}
cf() { "$PY" -c "import json,sys; d=json.load(open(sys.argv[2])); print(eval(sys.argv[1]))" "$1" "$(np "$S/cf.json")"; }
CFPY=("$PY" infra/dns/cloudflare-dns.py)
IP4=93.184.216.34 IP6=2606:2800:220:1:248:1893:25c8:1946
setup dns
printf 'CLOUDFLARE_DNS_TOKEN=%s\n' "$CFTOKEN" >"$S/secrets.env"
export PD_BASH="$(np "$(command -v bash)")"
out="$("${CFPY[@]}" apply --ipv4 $IP4 --ipv6 $IP6 --dry-run 2>&1)"; rc=$?
[[ $rc == 0 ]] && grep -q "proxied: true" <<<"$out" && grep -q "TTL 1" <<<"$out" && ! grep -qF -- "$CFTOKEN" <<<"$out" && ok "cloudflare-dns apply --dry-run shows proxied records, TTL 1, no token" || bad "cf dry-run" "$out"
! grep -qE "CAA|letsencrypt" <<<"$out" && ok "no CAA / ACME records (origin certificate, no certbot)" || bad "CAA in plan"
start_cf
out="$("${CFPY[@]}" apply --ipv4 $IP4 --ipv6 $IP6 2>&1)"; rc=$?
[[ $rc == 0 ]] && [[ "$(cf 'sorted((r["type"], r["content"], r["proxied"], r["ttl"]) for r in d["records"])')" == "[('A', '$IP4', True, 1), ('AAAA', '$IP6', True, 1)]" ]] && ok "apply creates the A and AAAA records, proxied, TTL 1" || bad "cf apply" "rc=$rc $out $(cf 'd["records"]')"
! grep -q 'auth=BAD' "$S/cf.calls" && grep -q 'auth=OK' "$S/cf.calls" && ! grep -qF -- "$CFTOKEN" <<<"$out" && ok "every API call carried the token in the header; it is not in the output" || bad "cf auth" "$(cat "$S/cf.calls")"
n1="$(grep -cE '^(POST|PATCH)' "$S/cf.calls")"
out="$("${CFPY[@]}" apply --ipv4 $IP4 --ipv6 $IP6 2>&1)"; rc=$?
[[ $rc == 0 && "$(grep -cE '^(POST|PATCH)' "$S/cf.calls")" == "$n1" ]] && grep -q "^ok " <<<"$out" && ok "a second apply changes nothing (idempotent)" || bad "cf idempotent" "$out"
out="$("${CFPY[@]}" apply --ipv4 93.184.216.35 --ipv6 $IP6 2>&1)"
[[ "$(cf '[r["content"] for r in d["records"] if r["type"]=="A"][0]')" == 93.184.216.35 ]] && grep -q "^updated" <<<"$out" && ok "a changed address updates the record in place (never deletes)" || bad "cf update" "$out"
"${CFPY[@]}" apply --ipv4 93.184.216.35 --ipv6 $IP6 >/dev/null 2>&1
out="$("${CFPY[@]}" check --ipv4 93.184.216.35 --ipv6 $IP6 2>&1)"; rc=$?
[[ $rc == 0 ]] && grep -q "CHECK: PASS" <<<"$out" && ok "check compares the API records with the server addresses (no DNS resolution)" || bad "cf check pass" "$out"
out="$("${CFPY[@]}" check --ipv4 93.184.216.99 --ipv6 $IP6 2>&1)"; rc=$?
[[ $rc == 1 ]] && grep -q "FAIL A" <<<"$out" && ok "check fails when the record holds another address" || bad "cf check fail" "$out"
# proxied flag drift
"$PY" - "$(np "$S/cf.json")" <<'PYEOF'
import json, sys
p = sys.argv[1]; d = json.load(open(p))
for r in d["records"]: r["proxied"] = False
json.dump(d, open(p, "w"))
PYEOF
out="$("${CFPY[@]}" check --ipv4 93.184.216.35 --ipv6 $IP6 2>&1)"; rc=$?
[[ $rc == 1 ]] && grep -q "proxied=False" <<<"$out" && ok "check fails when the proxied flag differs from [dns] proxied" || bad "cf proxied drift" "$out"
# the API URL guard
out="$(PD_CLOUDFLARE_API=https://api.example.net/client/v4 "${CFPY[@]}" apply --ipv4 $IP4 --ipv6 $IP6 --dry-run 2>&1)"; rc=$?
[[ $rc != 0 ]] && grep -q "PD_CLOUDFLARE_API must be" <<<"$out" && ok "a non-Cloudflare PD_CLOUDFLARE_API is refused (the token cannot go elsewhere)" || bad "cf url guard" "$out"
out="$(PD_CLOUDFLARE_API=http://evil.localhost.example.com/ "${CFPY[@]}" apply --ipv4 $IP4 --ipv6 $IP6 2>&1)"; rc=$?
[[ $rc != 0 ]] && ok "a look-alike host is refused too" || bad "cf lookalike"
# --from-provider goes through the dispatcher (ssh adapter: addresses from [infra.ssh])
sed -e 's/^ipv4 .*/ipv4           = "93.184.216.40"/' -e 's/^ipv6 .*/ipv6           = "2606:2800:220:1:248:1893:25c8:1950"/' config/tenant.toml >"$S/ssh.toml"
start_cf
out="$("${CFPY[@]}" apply --from-provider --tenant "$(np "$S/ssh.toml")" 2>&1)"; rc=$?
[[ $rc == 0 && "$(cf 'sorted(r["content"] for r in d["records"])')" == "['2606:2800:220:1:248:1893:25c8:1950', '93.184.216.40']" ]] && ok "apply --from-provider reads IPv4 + IPv6 through infra/server-addresses.sh (ssh adapter)" || bad "cf from-provider" "rc=$rc $out"
out="$("${CFPY[@]}" apply --from-provider --dry-run --tenant "$(np "$S/ssh.toml")" 2>&1)"
grep -q "from the 'ssh' adapter" <<<"$out" && ok "dry-run --from-provider names the adapter and makes no call" || bad "cf from-provider dry" "$out"
[[ -n "$CF_PID" ]] && { kill "$CF_PID" 2>/dev/null; CF_PID=""; }
unset PD_CLOUDFLARE_API PD_BASH


# ------------------------------------------------------------------ provider layer
o="$(bash infra/tests/test-providers.sh </dev/null 2>&1)"; rc=$?
[[ $rc == 0 ]] && ok "provider layer suite: $(tail -1 <<<"$o")" || bad "provider layer suite (bash infra/tests/test-providers.sh)" "$(grep -A1 '^FAIL' <<<"$o" | head -20)"

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
