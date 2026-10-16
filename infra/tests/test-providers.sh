#!/usr/bin/env bash
# infra/tests/test-providers.sh - offline tests for the pluggable provider layer (Drive D-146..D-149, mirrored in PD):
# infra/lib/provider.sh + the infra/*.sh dispatchers, infra/providers/hetzner (against a local fake Hetzner API,
# infra/tests/fakes/hcloud_fake.py, reached through PD_HCLOUD_API on 127.0.0.1), infra/providers/ssh,
# provider_subprocessor, infra/server/bootstrap-existing.sh (dry-run) and infra/switch-provider.sh.
# No internet, no billable call, nothing outside a temp dir. PD has no test tenant (open question Q-13): the
# Hetzner cases run from config/tenants/hetzner.example.toml with small test sizes.
# Usage: bash infra/tests/test-providers.sh        exit 0 = all pass
# shellcheck disable=SC2015  # test harness: A && ok || bad is intentional
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../ops/tests/lib.sh
. "$HERE/../../ops/tests/lib.sh"
harness_init "$(cd "$HERE/../.." && pwd)"
FAKE_PID=""
cleanup() {
  [[ -n "$FAKE_PID" ]] && kill "$FAKE_PID" 2>/dev/null
  cleanup_tmp
}
trap cleanup EXIT
guard_fakes
guard_no_luksformat
np() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }  # native path for python.exe
TOKEN="hz-TEST-token-$(printf '%040d' 7)"     # 64 chars like a real token; must never leak
export PD_HCLOUD_POLL=0
# fail closed until start_fake runs: a dead loopback port, never the real API
export PD_HCLOUD_API="http://127.0.0.1:9/v1" PD_CLOUDFLARE_API="http://127.0.0.1:9/client/v4"

# tenant variants -------------------------------------------------------------------------------
BASE_T="config/tenants/hetzner.example.toml"
TEST_T="$TMP/test-hetzner.toml"
mk_tenant() { # mk_tenant NAME 'python edits on s' [BASE]  -> $TMP/NAME.toml
  "$PY" - "$(np "${3:-$TEST_T}")" "$(np "$TMP/$1.toml")" "$2" <<'PYEOF'
import re, sys
s = open(sys.argv[1], encoding="utf-8").read()
def setv(key, value, sect=None):
    global s
    start = s.index("[%s]" % sect) if sect else 0
    head, tail = s[:start], s[start:]
    tail, n = re.subn(r"(?m)^(" + re.escape(key) + r"\s*=\s*)[^#\n]*", lambda m: m.group(1) + value + " ", tail, count=1)
    assert n == 1, key
    s = head + tail
exec(sys.argv[3])
open(sys.argv[2], "w", encoding="utf-8", newline="\n").write(s)
PYEOF
}
# the shared-project test server: adopted, never rescaled, root-container storage, small sizes (Drive D-148 shape)
mk_tenant test-hetzner 'setv("storage", "\"root-container\""); setv("dedicated_project", "false"); setv("data_name", "\"pd-test-data\""); setv("data_size_gb", "8"); setv("backup_name", "\"pd-test-backup\""); setv("backup_size_gb", "6")' "$BASE_T"
mk_tenant vol 'setv("storage", "\"volumes\"")'
mk_tenant prod 'setv("dedicated_project", "true")'
mk_tenant ssh 'setv("provider", "\"ssh\""); setv("ipv4", "\"203.0.113.80\""); setv("panel_url", "\"https://panel.example.net\""); setv("subprocessor", "\"Contabo GmbH\"", "infra")'
mk_tenant ssh-nosub 'setv("provider", "\"ssh\""); setv("ipv4", "\"203.0.113.80\"")'
mk_tenant bogus 'setv("provider", "\"nosuch\"")'
HOST="$("$PY" infra/lib/tenant.py get tenant.hostname --tenant "$(np "$TEST_T")")"

# secrets + fakes ---------------------------------------------------------------------------------
S="$TMP/s"; mkdir -p "$S/bin"
ssh-keygen -q -t ed25519 -N "" -C t@test -f "$S/key" >/dev/null 2>&1 || printf 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIfake t@test\n' >"$S/key.pub"
printf 'HCLOUD_TOKEN=%s\nSSH_PUBKEY_PATH=%s\nADMIN_IP=93.184.216.34\nCLOUDFLARE_DNS_TOKEN=cf-fake-token-0000\n' "$TOKEN" "$(np "$S/key.pub")" >"$S/secrets.env"
printf '#!/usr/bin/env bash\nprintf "ssh %%s\n" "$*" >>"%s/ssh.calls"; cat >/dev/null; exit 0\n' "$S" >"$S/bin/ssh"; chmod +x "$S/bin/ssh"
export PD_SECRETS="$S/secrets.env" PATH="$S/bin:$ORIG_PATH"
# shellcheck disable=SC2016  # a literal $6$ crypt hash
PDADMIN_HASH='$6$rounds=500000$saltsalt$'"$(printf '%086d' 0 | tr 0 a)"; export PDADMIN_HASH

start_fake() { # start_fake SEED_JSON
  [[ -n "$FAKE_PID" ]] && { kill "$FAKE_PID" 2>/dev/null; wait "$FAKE_PID" 2>/dev/null; }
  printf '%s' "$1" >"$TMP/hz.json"; : >"$TMP/hz.calls"; rm -f "$TMP/hz.port"
  "$PY" infra/tests/fakes/hcloud_fake.py "$(np "$TMP/hz.json")" "$(np "$TMP/hz.calls")" "$(np "$TMP/hz.port")" "$TOKEN" </dev/null >/dev/null 2>&1 &
  FAKE_PID=$!
  local _; for _ in $(seq 1 50); do [[ -s "$TMP/hz.port" ]] && break; sleep 0.1; done
  PD_HCLOUD_API="http://127.0.0.1:$(cat "$TMP/hz.port")/v1"; export PD_HCLOUD_API
}
hz() { "$PY" -c "import json,sys; d=json.load(open(sys.argv[2])); print(eval(sys.argv[1]))" "$1" "$(np "$TMP/hz.json")"; }
posts() { grep -c '^POST' "$TMP/hz.calls" || true; }
SEED_ADOPT='{"servers":[{"id":11,"name":"'"$HOST"'","status":"running","server_type":{"name":"cpx11"},"datacenter":{"location":{"name":"ash"}},"public_net":{"ipv4":{"ip":"198.51.100.11"},"ipv6":{"ip":"2001:db8:11::/64"},"firewalls":[]},"protection":{"delete":false,"rebuild":false},"rescue_enabled":false,"backup_window":null},{"id":12,"name":"someone-elses-box","status":"running","server_type":{"name":"cx22"},"datacenter":{"location":{"name":"fsn1"}},"public_net":{},"protection":{}}]}'

# ================================================================== dispatcher
out="$(bash infra/provision.sh --tenant "$TMP/bogus.toml" --dry-run 2>&1)"; rc=$?
[[ $rc != 0 ]] && grep -q "no adapter in infra/providers/nosuch" <<<"$out" && grep -q "hetzner" <<<"$out" && ok "dispatcher refuses an unknown provider and lists the adapters" || bad "unknown provider" "$out"
out="$(bash infra/firewall-temp-ssh.sh add --tenant "$TMP/ssh.toml" 2>&1)"; rc=$?
[[ $rc != 0 ]] && grep -q "no API firewall: the host firewall is the only filter" <<<"$out" && ok "ssh adapter: no firewall-temp-ssh verb, explains the host firewall" || bad "missing verb hint" "$out"
for p in ovh-us hetzner ssh; do
  # shellcheck disable=SC2013  # one line of space-separated verbs
  for v in $(sed -n 's/^verbs=//p' "infra/providers/$p/provider.conf"); do
    [[ -x "infra/providers/$p/$v.sh" ]] || bad "$p declares $v but infra/providers/$p/$v.sh is missing or not executable"
  done
done; ok "every declared verb has an executable script (ovh-us, hetzner, ssh)"
o="$(bash -c 'source infra/lib/tenant.sh; source infra/lib/provider.sh; PD_TENANT='"$TMP/vol.toml"' provider_storage; PD_TENANT='"$TEST_T"' provider_storage; PD_TENANT='"$TMP/ssh.toml"' provider_storage' 2>&1)"
[[ "$o" == $'volumes\nroot-container\nroot-container' ]] && ok "provider_storage honours [infra] storage" || bad "provider_storage" "$o"
mk_tenant sshvol 'setv("provider", "\"ssh\""); setv("storage", "\"volumes\"")'
o="$(bash -c 'source infra/lib/tenant.sh; source infra/lib/provider.sh; PD_TENANT='"$TMP/sshvol.toml"' provider_storage' 2>&1)"
grep -q "not supported by provider 'ssh'" <<<"$o" && ok "storage = volumes refused for the ssh adapter (single disk)" || bad "ssh volumes" "$o"

# ================================================================== hetzner: dry-run, guards
start_fake "$SEED_ADOPT"
out="$(bash infra/provision.sh --tenant "$TEST_T" --dry-run 2>&1)"; rc=$?
[[ $rc == 0 && ! -s "$TMP/hz.calls" ]] && grep -q "storage = root-container" <<<"$out" && ok "hetzner provision --dry-run: plan printed, no API call" || bad "hz dry-run" "rc=$rc $(head -3 "$TMP/hz.calls") $out"
out="$(bash infra/provision.sh --tenant "$TEST_T" 2>&1)"; rc=$?
[[ $rc != 0 && ! -s "$TMP/hz.calls" ]] && grep -q "confirm-purchase" <<<"$out" && ok "hetzner provision refuses without --confirm-purchase" || bad "hz confirm" "$out"
PD_SECRETS="$TMP/none.env" bash infra/provision.sh --tenant "$TEST_T" --confirm-purchase >"$TMP/o" 2>&1; rc=$?
[[ $rc != 0 ]] && grep -qi "secrets file not found\|HCLOUD_TOKEN" "$TMP/o" && ok "hetzner refuses without a token" || bad "no token" "$(cat "$TMP/o")"

# ================================================================== hetzner: adopt the existing test server
out="$(bash infra/provision.sh --tenant "$TEST_T" --confirm-purchase 2>&1)"; rc=$?
[[ $rc != 0 ]] && grep -q "adopt-existing" <<<"$out" && [[ "$(hz '[s for s in d["servers"] if s["id"]==11][0]["protection"]')" == "{'delete': False, 'rebuild': False}" ]] \
  && ! grep -q 'apply_to_resources' "$TMP/hz.calls" && ok "an existing server is only taken over with --adopt-existing (nothing attached before)" || bad "adopt consent" "$out"
out="$(bash infra/provision.sh --tenant "$TEST_T" --confirm-purchase --adopt-existing 2>&1)"; rc=$?
[[ $rc == 0 ]] && grep -q "adopted as it is" <<<"$out" && grep -q "never rescaled\|Not changed: a rescale" <<<"$out" && ok "existing server adopted, type difference only reported" || bad "adopt" "rc=$rc $out"
[[ "$(hz 'sum(1 for s in d["servers"] if s.get("RESCALED"))')" == 0 ]] && ! grep -q 'change_type' "$TMP/hz.calls" && ok "no rescale call (price list guard)" || bad "rescaled!"
[[ "$(hz 'len(d["servers"])')" == 2 ]] && ! grep -q '^POST /v1/servers ' "$TMP/hz.calls" && ok "no server created when one exists" || bad "server created"
[[ "$(hz '[s for s in d["servers"] if s["id"]==12][0].get("protection")')" == "{}" ]] && ok "the other server in the shared test project is untouched" || bad "touched other server"
[[ "$(hz 'sorted((r["protocol"], r.get("port","")) for r in d["firewalls"][0]["rules"])')" == "[('icmp', ''), ('tcp', '443'), ('udp', '41641')]" ]] \
  && ! grep -q '"22"' "$TMP/hz.json" && ok "firewall has exactly 443/icmp/41641, no SSH and no port 80" || bad "fw rules" "$(hz 'd["firewalls"]')"
[[ "$(hz '[a["server"]["id"] for a in d["firewalls"][0]["applied_to"]]')" == "[11]" ]] && ok "firewall applied to this server only" || bad "fw apply" "$(hz 'd["firewalls"][0]["applied_to"]')"
[[ "$(hz '[s for s in d["servers"] if s["id"]==11][0]["protection"]')" == "{'delete': True, 'rebuild': True}" ]] && ok "delete + rebuild protection set" || bad "protection"
[[ "$(hz 'len(d["volumes"])')" == 0 ]] && ok "root-container storage: no volume bought" || bad "volumes created in root-container mode"
grep -q "firewall-temp-ssh.sh add (SSH is closed now), then infra/server/bootstrap-existing.sh" <<<"$out" && ok "adoption points to temp SSH, then bootstrap-existing.sh" || bad "no bootstrap hint" "$out"
n1="$(posts)"; out="$(bash infra/provision.sh --tenant "$TEST_T" --confirm-purchase --adopt-existing 2>&1)"; rc=$?
[[ $rc == 0 && "$(posts)" == "$n1" ]] && grep -q "rules match" <<<"$out" && ok "second run changes nothing (idempotent)" || bad "not idempotent" "$(( $(posts) - n1 )) new POSTs; $out"
grep -q 'auth=BAD' "$TMP/hz.calls" && bad "a request went out without the right token" || ok "every API call carried the token in the header"
! grep -rqF -- "$TOKEN" "$TMP/hz.calls" "$TMP/hz.json" && ! grep -qF -- "$TOKEN" <<<"$out" && ok "token never in output, call log or state" || bad "token leaked"

# addresses / dns / volume verbs
o="$(bash infra/server-addresses.sh --tenant "$TEST_T" 2>&1)"
[[ "$o" == "198.51.100.11 2001:db8:11::1" ]] && ok "addresses: IPv4 + <prefix>::1" || bad "addresses" "$o"
o="$(bash infra/volume-ids.sh --tenant "$TEST_T" 2>&1)"; rc=$?
[[ $rc != 0 ]] && grep -q "root-container" <<<"$o" && ok "volume-ids refused for root-container storage" || bad "volume-ids rc" "$o"

o="$(PD_HCLOUD_API=https://api.example.net/v1 bash infra/server-addresses.sh --tenant "$TEST_T" 2>&1)"; rc=$?
[[ $rc != 0 ]] && grep -q "PD_HCLOUD_API must be https://api.hetzner.cloud/v1" <<<"$o" && ok "the token can only go to api.hetzner.cloud (or the local fake)" || bad "api url guard" "$o"
# another firewall on the server (shared project): its SSH rule must count for check 3 and rescue
"$PY" - "$TMP/hz.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
d["firewalls"].append({"id": 77, "name": "legacy-fw", "rules": [{"direction": "in", "protocol": "tcp", "port": "22", "source_ips": ["0.0.0.0/0"]}],
                       "applied_to": [{"type": "server", "server": {"id": 11}}]})
json.dump(d, open(sys.argv[1], "w"))
PY
o="$(bash infra/ssh-rules.sh --tenant "$TEST_T" 2>&1)"
grep -q "other firewall 'legacy-fw' is attached" <<<"$o" && grep -q "legacy-fw:0.*port 22 from 0.0.0.0/0" <<<"$o" && ok "ssh-rules sees SSH rules in EVERY firewall attached to the server" || bad "other fw" "$o"
o="$(bash infra/break-glass.sh rescue --confirm-reboot --tenant "$TEST_T" 2>&1)"; rc=$?
[[ $rc != 0 ]] && grep -q "attached alone" <<<"$o" && [[ "$(hz '[s for s in d["servers"] if s["id"]==11][0]["rescue_enabled"]')" == False ]] && ok "rescue refuses while another firewall is attached" || bad "rescue other fw" "$o"
"$PY" - "$TMP/hz.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1])); d["firewalls"] = [f for f in d["firewalls"] if f["id"] != 77]; json.dump(d, open(sys.argv[1], "w"))
PY
o="$(bash infra/server/bootstrap-existing.sh --tenant "$TEST_T" --confirm 2>&1)"; rc=$?
[[ $rc != 0 ]] && grep -q "no temporary SSH rule" <<<"$o" && ! grep -q '^ssh .*root@' "$S/ssh.calls" 2>/dev/null && ok "bootstrap-existing refuses while the provider firewall has no SSH rule (no futile root SSH)" || bad "bootstrap fw" "$o"

# ================================================================== hetzner: residency + dedicated project
start_fake "${SEED_ADOPT/\"ash\"/\"sin\"}"
out="$(bash infra/provision.sh --tenant "$TEST_T" --confirm-purchase 2>&1)"; rc=$?
[[ $rc != 0 ]] && grep -q "residency guard" <<<"$out" && ok "server outside [infra.hetzner] locations refused" || bad "residency" "$out"
start_fake "$SEED_ADOPT"
out="$(bash infra/provision.sh --tenant "$TMP/prod.toml" --confirm-purchase 2>&1)"; rc=$?
[[ $rc != 0 ]] && grep -q "needs its own project" <<<"$out" && ! grep -q '^POST' "$TMP/hz.calls" && ok "dedicated_project = true refuses a shared project before any change" || bad "dedicated" "$out"

# ================================================================== hetzner: create (volumes)
start_fake '{}'
out="$(bash infra/provision.sh --tenant "$TMP/vol.toml" --confirm-purchase 2>&1)"; rc=$?
[[ $rc == 0 && "$(hz 'len(d["servers"])')" == 1 ]] && ok "server created when missing" || bad "create" "rc=$rc $out"
[[ "$(hz 'd["servers"][0]["user_data_seen"]')" == True ]] && ok "created with the rendered cloud-init (host firewall inside)" || bad "user-data"
[[ "$(hz 'sorted((v["name"], v["size"], v["server"] is not None, v["protection"]["delete"]) for v in d["volumes"])')" == "[('pd-test-backup', 6, True, True), ('pd-test-data', 8, True, True)]" ]] \
  && ok "two volumes created, attached, delete-protected" || bad "volumes" "$(hz 'd["volumes"]')"
[[ "$(hz '[a["server"]["id"] for a in d["firewalls"][0]["applied_to"]]' | tr -d ' ')" =~ ^\[[0-9]+\]$ ]] && ok "firewall attached at creation, not twice" || bad "fw twice" "$(hz 'd["firewalls"][0]["applied_to"]')"
o="$(bash infra/volume-ids.sh --tenant "$TMP/vol.toml" 2>&1)"
[[ "$(awk '{print $1}' <<<"$o" | tr '\n' ' ')" == "data backup " ]] && ok "volume-ids prints data/backup ids" || bad "volume-ids" "$o"
o="$(bash infra/volume-extend.sh --tenant "$TMP/vol.toml" --volume data --size 4 --confirm-purchase 2>&1)"; rc=$?
[[ $rc != 0 ]] && grep -q "never shrink" <<<"$o" && ok "volume-extend refuses to shrink" || bad "shrink" "$o"
o="$(bash infra/volume-extend.sh --tenant "$TMP/vol.toml" --volume data --size 20 2>&1)"; rc=$?
[[ $rc != 0 ]] && grep -q "confirm-purchase" <<<"$o" && ok "volume-extend needs --confirm-purchase" || bad "extend confirm" "$o"
bash infra/volume-extend.sh --tenant "$TMP/vol.toml" --volume data --size 20 --confirm-purchase >/dev/null 2>&1
[[ "$(hz '[v["size"] for v in d["volumes"] if v["name"]=="pd-test-data"][0]')" == 20 ]] && ok "volume-extend grows the volume" || bad "grow"

# ================================================================== hetzner: temporary SSH + check 3 source
out="$(bash infra/firewall-temp-ssh.sh add --tenant "$TMP/vol.toml" 2>&1)"; rc=$?
[[ $rc == 0 && "$(hz 'sum(1 for r in d["firewalls"][0]["rules"] if r.get("port")=="22")')" == 1 ]] && ok "temp SSH rule added from ADMIN_IP/32" || bad "temp add" "$out"
[[ "$(hz '[r["source_ips"] for r in d["firewalls"][0]["rules"] if r.get("port")=="22"][0]')" == "['93.184.216.34/32']" ]] && ok "rule source is exactly the admin /32" || bad "src"
bash infra/firewall-temp-ssh.sh add --tenant "$TMP/vol.toml" >/dev/null 2>&1
[[ "$(hz 'sum(1 for r in d["firewalls"][0]["rules"] if r.get("port")=="22")')" == 1 ]] && ok "added twice: no duplicate" || bad "dup"
o="$(bash infra/ssh-rules.sh --tenant "$TMP/vol.toml" 2>&1)"
grep -q "tcp port 22 from 93.184.216.34/32" <<<"$o" && ok "ssh-rules reports the open rule (doc 01 check 3 input)" || bad "ssh-rules" "$o"
o="$(bash infra/firewall-temp-ssh.sh add --tenant "$TMP/vol.toml" --ip 10.0.0.5 2>&1)"; rc=$?
[[ $rc != 0 ]] && ok "private source IP refused" || bad "private ip"
o="$(bash infra/break-glass.sh rescue --tenant "$TMP/vol.toml" 2>&1)"; rc=$?
[[ $rc != 0 ]] && grep -q "confirm-reboot" <<<"$o" && ok "rescue refuses without --confirm-reboot" || bad "rescue confirm" "$o"
o="$(bash infra/break-glass.sh rescue --confirm-reboot --tenant "$TMP/vol.toml" 2>&1)"; rc=$?
[[ $rc == 0 ]] && ! grep -q "fake-root-pw" <<<"$o" && [[ "$(hz 'd["servers"][0]["rescue_enabled"]')" == True ]] && ok "rescue with key only; the root password is never printed" || bad "rescue" "$o"
bash infra/break-glass.sh unrescue --tenant "$TMP/vol.toml" >/dev/null 2>&1
[[ "$(hz 'd["servers"][0]["rescue_enabled"]')" == False ]] && ok "unrescue leaves rescue mode" || bad "unrescue"
o="$(bash infra/firewall-temp-ssh.sh remove --tenant "$TMP/vol.toml" 2>&1)"; rc=$?
[[ $rc != 0 && "$(hz 'sum(1 for r in d["firewalls"][0]["rules"] if r.get("port")=="22")')" == 1 ]] && ok "remove without --check-host refused, rule kept" || bad "remove guard" "$o"
o="$(bash infra/firewall-temp-ssh.sh remove --check-host 203.0.113.9 --tenant "$TMP/vol.toml" 2>&1)"; rc=$?
[[ $rc != 0 ]] && grep -q "admin network" <<<"$o" && ok "remove refuses a public --check-host" || bad "public check-host" "$o"
o="$(bash infra/firewall-temp-ssh.sh remove --check-host 100.64.0.5 --tenant "$TMP/vol.toml" 2>&1)"; rc=$?
[[ $rc == 0 ]] && grep -q "VERIFIED" <<<"$o" && grep -q "pdadmin@100.64.0.5 true" "$S/ssh.calls" \
  && [[ "$(hz 'sum(1 for r in d["firewalls"][0]["rules"] if r.get("port")=="22")')" == 0 && "$(hz 'len(d["firewalls"][0]["rules"])')" == 3 ]] \
  && ok "remove: admin-network SSH checked, rule gone, the 3 public rules kept" || bad "remove" "$o"
[[ -z "$(bash infra/ssh-rules.sh --tenant "$TMP/vol.toml" 2>&1)" ]] && ok "ssh-rules empty after remove" || bad "ssh-rules after"
! grep -rqF -- "$TOKEN" "$TMP/hz.calls" "$S/ssh.calls" && ok "token never in a call log" || bad "token leak 2"

# ================================================================== ssh adapter
o="$(bash infra/server-addresses.sh --tenant "$TMP/ssh.toml" 2>&1)"
[[ "$o" == "203.0.113.80 -" ]] && ok "ssh adapter: addresses from [infra.ssh]" || bad "ssh addresses" "$o"
o="$(bash infra/provision.sh --tenant "$TMP/ssh.toml" --dry-run 2>&1)"; rc=$?
[[ $rc == 0 ]] && grep -q "read-only probe" <<<"$o" && grep -q "host nftables only" <<<"$o" && ok "ssh adapter: provision --dry-run plans a read-only probe" || bad "ssh plan" "$o"
o="$(bash infra/break-glass.sh console --tenant "$TMP/ssh.toml" 2>&1)"
grep -q "panel.example.net" <<<"$o" && ok "ssh adapter: break-glass points at the provider panel" || bad "ssh break-glass" "$o"

# ================================================================== bootstrap-existing + switch-provider (dry)
o="$(bash infra/server/bootstrap-existing.sh --tenant "$TEST_T" --dry-run 2>&1)"; rc=$?
[[ $rc == 0 ]] && grep -q "seedfrom: file:///etc/pd/cloud-seed/" <<<"$o" && grep -q "network: {config: disabled}" <<<"$o" && grep -q "bootstrap.done" <<<"$o" \
  && ok "bootstrap-existing --dry-run: NoCloud seed, provider network kept, run-once marker" || bad "bootstrap dry" "$o"
grep -q "ssh_deletekeys: false" <<<"$o" && grep -q "touch /etc/cloud/cloud-init.disabled" <<<"$o" && grep -q "tar --no-same-owner" <<<"$o" \
  && grep -q 'user-data.txt\*' <<<"$o" && ! grep -q "clean --logs" <<<"$o" \
  && ok "bootstrap keeps host keys, disables cloud-init afterwards, root-owned seed, removes cloud-init's user-data copies, keeps logs" || bad "bootstrap hardening" "$o"
o="$(bash infra/server/bootstrap-existing.sh --tenant "$TEST_T" 2>&1)"; rc=$?
[[ $rc != 0 ]] && grep -q "\-\-confirm" <<<"$o" && ok "bootstrap-existing refuses without --confirm" || bad "bootstrap confirm"
# ================================================================== provider_subprocessor (privacy statement)
sp() { bash -c 'source infra/lib/tenant.sh; source infra/lib/provider.sh; PD_TENANT="$1" provider_subprocessor' _ "$1" 2>&1; }
o="$(sp "$TMP/vol.toml")"
[[ "$o" == "Hetzner Online GmbH (hosting)" ]] && ok "provider_subprocessor: hetzner gives 'Hetzner Online GmbH (hosting)'" || bad "subprocessor hetzner" "$o"
mk_tenant ovh 'setv("provider", "\"ovh-us\""); setv("storage", "\"volumes\"")'
o="$(sp "$TMP/ovh.toml")"
[[ "$o" == "OVH US LLC (OVHcloud US, hosting)" ]] && ok "provider_subprocessor: ovh-us gives 'OVH US LLC (OVHcloud US, hosting)'" || bad "subprocessor ovh" "$o"
o="$(sp "$TMP/ssh-nosub.toml")"
grep -q "set \[infra\] subprocessor" <<<"$o" && ok "provider_subprocessor: ssh with an empty [infra] subprocessor dies and says what to set" || bad "ssh empty subprocessor" "$o"
o="$(sp "$TMP/ssh.toml")"
[[ "$o" == "Contabo GmbH" ]] && ok "provider_subprocessor: ssh with [infra] subprocessor = 'Contabo GmbH' prints it" || bad "ssh named subprocessor" "$o"
mk_tenant ovh-override 'setv("subprocessor", "\"Example Hosting Inc\"", "infra"); setv("provider", "\"hetzner\"")'
o="$(sp "$TMP/ovh-override.toml")"
[[ "$o" == "Example Hosting Inc" ]] && ok "[infra] subprocessor overrides the adapter's value" || bad "override" "$o"

# ================================================================== switch-provider.sh (Drive D-149)
mk_tenant other 'import re; s = re.sub(r"(?m)^id(\s*)=.*$", "id = \"someone-else\"", s, count=1)'
o="$(bash infra/switch-provider.sh plan --tenant "$TMP/ssh.toml" --to "$TMP/other.toml" 2>&1)"; rc=$?
[[ $rc != 0 ]] && grep -q "tenant.id differs" <<<"$o" && ok "switch refuses a target file of another tenant" || bad "switch other tenant" "$o"
for key in tenant.domain tenant.hostname backup.bucket backup.crypt_prefix; do
  sect="${key%%.*}"; name="${key#*.}"
  mk_tenant "diff-$name" "setv('$name', '\"changed-$name\"', '$sect')"
  o="$(bash infra/switch-provider.sh plan --tenant "$TMP/ssh.toml" --to "$TMP/diff-$name.toml" 2>&1)"; rc=$?
  [[ $rc != 0 ]] && grep -q "$key differs" <<<"$o" && ok "switch refuses when $key differs" || bad "switch $key check" "$o"
done
o="$(bash infra/switch-provider.sh plan --tenant "$TMP/ssh.toml" --to "$TMP/vol.toml" 2>&1)"; rc=$?
[[ $rc == 0 ]] && grep -q "from 'ssh' to 'hetzner'" <<<"$o" && grep -q "restore-runbook.md section 3" <<<"$o" && grep -q "cutover --to" <<<"$o" && ok "switch plan: ordered checklist via the restore path" || bad "switch plan" "$o"
grep -q "rsync -aHAX --numeric-ids pdadmin@<old tailnet IP>:/mnt/pddata/files/ /mnt/pddata/files/" <<<"$o" && ok "switch plan copies the live files with rsync (plan 01 s4: they are not in the backups)" || bad "rsync step" "$o"
grep -q "NEW server's tailnet IP" <<<"$o" && ok "switch plan warns: --check-host must be the new node's tailnet IP" || bad "check-host warning" "$o"
grep -q "restore.sh --archive latest --confirm" <<<"$o" && grep -q "backup.sh" <<<"$o" && grep -q "stop api worker" <<<"$o" && ok "switch plan: stop api/worker and back up on the old server, restore.sh on the new one" || bad "restore steps" "$o"
l_bk="$(grep -n 'sudo /opt/pd/infra/scripts/backup.sh' <<<"$o" | head -1 | cut -d: -f1)"; l_dis="$(grep -n 'sudo systemctl disable --now pd-backup.timer' <<<"$o" | head -1 | cut -d: -f1)"; l_build="$(grep -n 'switch-provider.sh build' <<<"$o" | head -1 | cut -d: -f1)"
[[ -n "$l_bk" && -n "$l_dis" && -n "$l_build" ]] && (( l_bk < l_dis && l_dis < l_build )) \
  && ok "switch plan step 0: after the final backup, disable pd-backup.timer on the OLD server (before the new one is built)" || bad "timer disable step" "bk=$l_bk dis=$l_dis build=$l_build $o"
grep -q "backup.sh --adopt-offsite" <<<"$o" && grep -q "sudo ops/install.sh" <<<"$o" && ok "switch plan: the new server takes the B2 prefix over once (--adopt-offsite) and installs its timers" || bad "adopt step" "$o"
o="$(bash infra/switch-provider.sh build --tenant "$TMP/ssh.toml" --to "$TMP/vol.toml" 2>&1)"; rc=$?
[[ $rc != 0 ]] && grep -q "\-\-confirm" <<<"$o" && ok "switch build refuses without --confirm" || bad "switch confirm" "$o"
o="$(bash infra/switch-provider.sh cutover --tenant "$TMP/ssh.toml" --to "$TMP/vol.toml" 2>&1)"; rc=$?
[[ $rc != 0 ]] && grep -q "\-\-confirm" <<<"$o" && ok "switch cutover refuses without --confirm" || bad "cutover confirm" "$o"
: >"$TMP/hz.calls"
o="$(bash infra/switch-provider.sh build --tenant "$TMP/ssh.toml" --to "$TMP/vol.toml" --dry-run 2>&1)"; rc=$?
[[ $rc == 0 && ! -s "$TMP/hz.calls" ]] && grep -q "infra/provision.sh\|provision.sh" <<<"$o" && ! grep -q "bootstrap-existing.sh --tenant.*--dry-run" <<<"$o" && ok "switch build --dry-run to hetzner: provision only (cloud-init came with the server), no API call" || bad "switch dry" "$o"
o="$(bash infra/switch-provider.sh build --tenant "$TMP/vol.toml" --to "$TMP/ssh.toml" --dry-run 2>&1)"; rc=$?
[[ $rc == 0 ]] && grep -q "applying infra/cloud-init.yaml now" <<<"$o" && ok "switch build to the ssh adapter also bootstraps" || bad "switch to ssh" "$o"
o="$(bash infra/switch-provider.sh plan --tenant "$TMP/ssh.toml" --to "$TMP/ssh.toml" 2>&1)"; rc=$?
[[ $rc != 0 ]] && grep -q "current tenant file itself" <<<"$o" && ok "switch refuses --to naming the current file" || bad "switch same file" "$o"

# ------------------------------------------------------------------ luks_find_byid
mkdir -p "$S/byid"; U=0d9e8f7a-1b2c-4d5e-8f90-a1b2c3d4e5f6
ln -s /dev/null "$S/byid/scsi-0QEMU_QEMU_HARDDISK_$U"; ln -s /dev/null "$S/byid/virtio-${U:0:20}"
o="$(PD_BYID_DIR="$S/byid" bash -c 'die(){ echo "DIE $*"; exit 1; }; warn(){ :; }; is_dry(){ return 1; }; source infra/luks/luks-common.sh; luks_find_byid "$1"' _ "$U" 2>&1)"
[[ "$o" == "$S/byid/scsi-0QEMU_QEMU_HARDDISK_$U" ]] && ok "luks_find_byid: virtio-scsi name preferred" || bad "find_byid" "$o"
o="$(PD_BYID_DIR="$S/byid" bash -c 'die(){ echo "DIE $*"; exit 1; }; source infra/luks/luks-common.sh; luks_find_byid 12ab' 2>&1)"
grep -q 'DIE volume id must be' <<<"$o" && ok "luks_find_byid refuses an id that is neither a UUID nor a Hetzner number" || bad "non-uuid" "$o"
ln -sf /dev/zero "$S/byid/virtio-${U:0:20}"
o="$(PD_BYID_DIR="$S/byid" bash -c 'die(){ echo "DIE $*"; exit 1; }; source infra/luks/luks-common.sh; luks_find_byid "$1"' _ "$U" 2>&1)"
grep -q 'point to different devices' <<<"$o" && ok "luks_find_byid refuses links to different devices" || bad "ambiguous byid" "$o"
ln -s /dev/null "$S/byid/scsi-0HC_Volume_1234567"
o="$(PD_BYID_DIR="$S/byid" bash -c 'die(){ echo "DIE $*"; exit 1; }; source infra/luks/luks-common.sh; luks_find_byid 1234567' 2>&1)"
[[ "$o" == "$S/byid/scsi-0HC_Volume_1234567" ]] && ok "luks_find_byid: Hetzner volume id -> scsi-0HC_Volume_<id>" || bad "hetzner byid" "$o"
o="$(PD_BYID_DIR="$S/byid" bash -c 'die(){ echo "DIE $*"; exit 1; }; source infra/luks/luks-common.sh; luks_find_byid ../../etc' 2>&1)"
grep -q "DIE volume id must be" <<<"$o" && ok "luks_find_byid refuses a path-like id" || bad "path id" "$o"
# container ids (non-root checks): path and id must match, symlinks refused
L="$S/luks"; mkdir -p "$L/disks"
lc() { PD_CONTAINER_DIR="$L/disks" bash -c 'die(){ echo "DIE $*"; exit 1; }; warn(){ :; }; is_dry(){ return 1; }; source infra/luks/luks-common.sh; '"$1" 2>&1; }
o="$(lc 'luks_check_dev_path '"$L"'/disks/pdbackup.img container-pddata')"
grep -q "DIE container path" <<<"$o" && ok "container id must match its own file (no cross-wiring)" || bad "container cross" "$o"
ln -s "$L/disks/pddata.img" "$L/disks/pdbackup.img"
o="$(lc 'luks_check_dev_path '"$L"'/disks/pdbackup.img container-pdbackup')"
grep -q "DIE .*not a regular file" <<<"$o" && ok "a symlinked container is refused" || bad "symlink" "$o"
rm -f "$L/disks/pdbackup.img"


# ================================================================== static
"$PY" - <<'PYEOF2' && ok "hapi.py, netutil.py and the Hetzner fake compile" || bad "python syntax"
import sys
from pathlib import Path
bad = []
for p in ("infra/providers/hetzner/hapi.py", "infra/lib/netutil.py", "infra/tests/fakes/hcloud_fake.py"):
    try:
        compile(Path(p).read_text(encoding="utf-8"), p, "exec")
    except SyntaxError as exc:
        bad.append(f"{p}: {exc}")
print(chr(10).join(bad))
sys.exit(1 if bad else 0)
PYEOF2

summary
