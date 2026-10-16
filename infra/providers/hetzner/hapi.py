#!/usr/bin/env python3
"""Hetzner Cloud adapter core (Drive D-146, D-148). Called by infra/providers/hetzner/*.sh.

Implements docs/plans/01-infrastructure.md sections 2 (server, volumes, protection), s3 (provider firewall:
443/ICMP/41641 in, no SSH), 3 (addresses for DNS), 4 (temporary SSH rule) and 4.1 (break-glass)
on the Hetzner Cloud API v1 (https://api.hetzner.cloud/v1). Field names follow the public API and the
official hcloud clients; each is *verify* on the first live run (HUMAN-TODO H-02).

Secrets: the API token comes from the environment (HCLOUD_TOKEN, loaded from the secrets file by
infra/lib/tenant.sh), is sent only in the Authorization header, and is never printed or put in argv.
Tests point PD_HCLOUD_API at a local fake (http://127.0.0.1:<port>/v1); any other URL than the real API
(https://api.hetzner.cloud/v1, provider.conf api_host) is refused, so the token cannot be sent elsewhere.

Guards (the same rules as the OVH adapter, adapted):
  - only the server named tenant.hostname is ever touched; nothing is ever deleted
  - an existing server is ADOPTED as it is: its type is never changed (since 15 June 2026 a rescale
    moves a server to the current, higher price list), only reported
  - [infra.hetzner] locations is the residency allow-list: a server or volume outside it is refused
  - [infra.hetzner] dedicated_project = true refuses a project holding other servers (production);
    false only warns (a shared test project, D-148)
  - billable creation needs --confirm-purchase; --dry-run makes no API call at all

Subcommands (all take --tenant PATH via PD_TENANT, and --dry-run where noted):
  provision [--dry-run] [--confirm-purchase] [--user-data FILE] [--storage volumes|root-container]
  addresses                       "<ipv4> <ipv6>" ("-" for a missing family; IPv6 = <prefix>::1)
  ssh-rules                       firewall rules covering TCP 22, "<index>\\t<summary>" per line
  temp-ssh add --cidr CIDR        add one TCP 22 rule from a single address (idempotent)
  temp-ssh remove                 remove every TCP 22 rule; prints VERIFIED when none is left
  status | console | rescue --confirm-reboot | unrescue
  volume-ids                      "data <id>" / "backup <id>" (numeric Hetzner volume ids)
  volume-extend --volume data|backup --size GB [--confirm-purchase]
"""
from __future__ import annotations

import argparse
import ipaddress
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "lib"))
import tenant

API_DEFAULT = "https://api.hetzner.cloud/v1"
LOCAL_TEST_PREFIXES = ("http://127.0.0.1:", "http://localhost:")
TEMP_SSH_TAG = "pd-temp-ssh"
ANY4, ANY6 = "0.0.0.0/0", "::/0"


class Fail(Exception):
    pass


def desired_rules() -> list[dict[str, Any]]:
    """Plan 01 s3: public 443, ICMP and Tailscale UDP 41641; no SSH. Egress: none listed =
    all outbound allowed (Hetzner applies rules per direction)."""
    both = [ANY4, ANY6]
    return [
        {"direction": "in", "protocol": "tcp", "port": "443", "source_ips": both, "description": "https (plan 01)"},
        {"direction": "in", "protocol": "icmp", "source_ips": both, "description": "icmp (plan 01)"},
        {"direction": "in", "protocol": "udp", "port": "41641", "source_ips": both, "description": "tailscale direct (plan 01)"},
    ]


def rule_key(r: dict[str, Any]) -> tuple[str, str, str, tuple[str, ...]]:
    return (str(r.get("direction")), str(r.get("protocol")), str(r.get("port") or ""),
            tuple(sorted(r.get("source_ips") or [])))


def covers_tcp22(r: dict[str, Any]) -> bool:
    if r.get("direction") != "in" or r.get("protocol") != "tcp":
        return False
    port = str(r.get("port") or "")
    if not port or port == "any":
        return True
    if "-" in port:
        lo, hi = port.split("-", 1)
        return int(lo) <= 22 <= int(hi)
    return port == "22"


def is_temp_ssh(r: dict[str, Any]) -> bool:
    return covers_tcp22(r) and str(r.get("description") or "").startswith(TEMP_SSH_TAG) \
        and str(r.get("port")) == "22" and len(r.get("source_ips") or []) == 1


def summary(r: dict[str, Any]) -> str:
    return (f"{r.get('direction')} {r.get('protocol')} port {r.get('port') or 'any'} from "
            f"{','.join(r.get('source_ips') or [])} ({r.get('description') or '-'})")


# ------------------------------------------------------------------ API transport
class Api:
    def __init__(self, dry: bool) -> None:
        self.dry = dry
        self.base = os.environ.get("PD_HCLOUD_API", API_DEFAULT).rstrip("/")
        if self.base != API_DEFAULT and not self.base.startswith(LOCAL_TEST_PREFIXES):
            raise Fail(f"PD_HCLOUD_API must be {API_DEFAULT} (got {self.base!r}); a 127.0.0.1 URL only for the test fake")
        self.token = os.environ.get("HCLOUD_TOKEN", "")
        if not dry and not self.token:
            raise Fail("HCLOUD_TOKEN is not set: add the project's Read & Write API token to the secrets file "
                       "(HCLOUD_TOKEN=...; HUMAN-TODO H-02). Never paste it on a command line.")

    def call(self, method: str, path: str, body: dict[str, Any] | None = None,
             query: dict[str, str] | None = None) -> dict[str, Any]:
        if self.dry:
            raise Fail(f"internal: API call {method} {path} attempted under --dry-run")
        url = self.base + path
        if query:
            url += "?" + urllib.parse.urlencode(query)
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Authorization", f"Bearer {self.token}")
        req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as exc:
            try:
                err = json.loads(exc.read() or b"{}").get("error", {})
            except ValueError:
                err = {}
            raise Fail(f"Hetzner API {method} {path}: HTTP {exc.code} {err.get('code', '')} "
                       f"{str(err.get('message', ''))[:200]}") from None
        except urllib.error.URLError as exc:
            raise Fail(f"Hetzner API {method} {path}: {exc.reason}") from None
        return json.loads(raw) if raw else {}

    def find(self, kind: str, name: str) -> dict[str, Any] | None:
        items = self.call("GET", f"/{kind}", query={"name": name}).get(kind, [])
        exact = [i for i in items if i.get("name") == name]
        if len(exact) > 1:
            raise Fail(f"{len(exact)} {kind} are named {name}; resolve the duplicate in the Hetzner Console first")
        return exact[0] if exact else None

    def list_all(self, kind: str) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        page = 1
        while True:
            doc = self.call("GET", f"/{kind}", query={"page": str(page), "per_page": "50"})
            out += doc.get(kind, [])
            nxt = ((doc.get("meta") or {}).get("pagination") or {}).get("next_page")
            if not nxt:
                return out
            page = int(nxt)

    def wait(self, action: dict[str, Any] | None, what: str) -> None:
        if not action or "id" not in action:
            return
        for _ in range(120):
            a = self.call("GET", f"/actions/{action['id']}").get("action", {})
            if a.get("status") == "success":
                return
            if a.get("status") == "error":
                raise Fail(f"{what} failed: {(a.get('error') or {}).get('message', 'unknown error')}")
            time.sleep(float(os.environ.get("PD_HCLOUD_POLL", "2")))
        raise Fail(f"{what}: action {action['id']} did not finish in time")


# ------------------------------------------------------------------ tenant values
class Cfg:
    def __init__(self) -> None:
        t = tenant.load()
        self.t = t
        if tenant.get(t, "infra.provider") != "hetzner":
            raise Fail(f"[infra] provider is {tenant.get(t, 'infra.provider')!r}, not 'hetzner'")
        self.tenant_id = str(tenant.get(t, "tenant.id"))
        self.host = str(tenant.get(t, "tenant.hostname"))
        self.key_name = str(tenant.get(t, "tenant.ssh_key_name"))
        h = tenant.get(t, "infra.hetzner")
        self.location = str(h["location"])
        self.locations = [str(x) for x in h.get("locations", [self.location])]
        self.server_type = str(h["server_type"])
        self.image = str(h.get("image", "ubuntu-24.04"))
        self.firewall = str(h.get("firewall", "fw-pd"))
        self.dedicated = bool(h.get("dedicated_project", True))
        self.storage = str(tenant.get(t, "infra.storage", "volumes"))
        if self.storage not in ("volumes", "root-container"):
            raise Fail(f"[infra] storage must be 'volumes' or 'root-container', got {self.storage!r}")
        if self.location not in self.locations:
            raise Fail(f"[infra.hetzner] location {self.location!r} is not in locations {self.locations}")
        self.vol = {
            "data": (str(tenant.get(t, "volumes.data_name")), int(tenant.get(t, "volumes.data_size_gb"))),
            "backup": (str(tenant.get(t, "volumes.backup_name")), int(tenant.get(t, "volumes.backup_size_gb"))),
        }
        self.labels = {"pd-tenant": self.tenant_id}


def say(msg: str) -> None:
    print(msg, flush=True)


def warn(msg: str) -> None:
    print(f"WARN: {msg}", file=sys.stderr, flush=True)


def location_of(obj: dict[str, Any]) -> str:
    if isinstance(obj.get("location"), dict):
        return str(obj["location"].get("name"))
    dc = obj.get("datacenter") or {}
    return str((dc.get("location") or {}).get("name", ""))


def server_or_die(api: Api, cfg: Cfg) -> dict[str, Any]:
    s = api.find("servers", cfg.host)
    if not s:
        raise Fail(f"no server named {cfg.host} in this Hetzner project (tenant.hostname)")
    loc = location_of(s)
    if loc not in cfg.locations:
        raise Fail(f"server {cfg.host} is in {loc!r}, outside [infra.hetzner] locations {cfg.locations} (residency guard)")
    return s


def addresses_of(s: dict[str, Any]) -> tuple[str, str]:
    pn = s.get("public_net") or {}
    v4 = ((pn.get("ipv4") or {}).get("ip")) or "-"
    v6net = ((pn.get("ipv6") or {}).get("ip")) or ""
    v6 = "-"
    if v6net:
        # Hetzner assigns a /64; Ubuntu images configure <prefix>::1 on eth0 (*verify*: ip -6 addr).
        v6 = str(ipaddress.ip_network(v6net, strict=False).network_address + 1)
    return v4, v6


def project_guard(api: Api, cfg: Cfg) -> None:
    others = [s.get("name") for s in api.list_all("servers")
              if s.get("name") != cfg.host and not str(s.get("name", "")).startswith("pd-drill-")]
    if not others:
        return
    msg = f"this Hetzner project also holds other servers ({', '.join(map(str, others))})"
    if cfg.dedicated:
        raise Fail(msg + ": production needs its own project ([infra.hetzner] dedicated_project = true)")
    warn(msg + ". Only " + cfg.host + " is touched (dedicated_project = false: test project, D-148).")


# ------------------------------------------------------------------ provision
def cmd_provision(args: argparse.Namespace) -> int:
    cfg = Cfg()
    storage = args.storage or cfg.storage
    say("Provider        : Hetzner Cloud (api.hetzner.cloud), project of the HCLOUD_TOKEN")
    say(f"Server          : {cfg.host}  type {cfg.server_type} (only when CREATED; an existing server is adopted "
        f"as it is, never rescaled)  image {cfg.image}  location {cfg.location}  (allowed: {', '.join(cfg.locations)})")
    say(f"Firewall        : {cfg.firewall}  in: tcp/443, icmp, udp/41641 from any; NO SSH; applied to {cfg.host}")
    if storage == "volumes":
        for role, (name, size) in cfg.vol.items():
            say(f"Volume          : {name}  {size} GB  {role}  attached, unformatted (automount off), delete-protected")
    else:
        say("Volumes         : none (storage = root-container: LUKS containers on the root disk, D-147)")
    say("Protection      : server delete + rebuild protection; Hetzner backups stay OFF (they copy the LUKS keyfiles)")
    if args.dry_run:
        say("(dry-run: the Hetzner API is NOT called; a real run checks each resource by name and creates only what is missing)")
        return 0
    if not args.confirm_purchase:
        raise Fail("refusing to create or change billable resources without --confirm-purchase (preview with --dry-run)")
    api = Api(dry=False)
    project_guard(api, cfg)

    # 1. Firewall
    say(f"== Firewall: {cfg.firewall}")
    fw = api.find("firewalls", cfg.firewall)
    want = desired_rules()
    if not fw:
        fw = api.call("POST", "/firewalls", {"name": cfg.firewall, "labels": cfg.labels, "rules": want})["firewall"]
        say("created")
    else:
        have = {rule_key(r) for r in fw.get("rules", [])}
        missing = [r for r in want if rule_key(r) not in have]
        extra = [r for r in fw.get("rules", []) if rule_key(r) not in {rule_key(w) for w in want} and not is_temp_ssh(r)]
        if missing:
            keep = list(fw.get("rules", []))
            for a in api.call("POST", f"/firewalls/{fw['id']}/actions/set_rules", {"rules": keep + missing}).get("actions") or []:
                api.wait(a, "set firewall rules")
            say(f"added {len(missing)} missing rule(s)")
        for r in extra:
            warn(f"firewall {cfg.firewall} has a rule outside plan 01: {summary(r)} (not removed automatically)")
        if not missing and not extra:
            say("rules match")

    # 2. SSH key (used at creation and for rescue)
    key = api.find("ssh_keys", cfg.key_name)
    if not key:
        pub_path = os.environ.get("SSH_PUBKEY_PATH", "")
        if not pub_path or not Path(pub_path).is_file():
            raise Fail("SSH_PUBKEY_PATH (secrets file) must name the admin's .pub file")
        pub = Path(pub_path).read_text(encoding="utf-8").strip()
        key = api.call("POST", "/ssh_keys", {"name": cfg.key_name, "public_key": pub, "labels": cfg.labels})["ssh_key"]
        say(f"== SSH key {cfg.key_name}: uploaded")

    # 3. Server
    say(f"== Server: {cfg.host}")
    srv = api.find("servers", cfg.host)
    if srv:
        loc = location_of(srv)
        if loc not in cfg.locations:
            raise Fail(f"server {cfg.host} is in {loc!r}, outside [infra.hetzner] locations (residency guard)")
        have_type = (srv.get("server_type") or {}).get("name")
        say(f"exists - adopted as it is ({have_type}, {loc}); not created, not rescaled")
        on = any(a.get("type") == "server" and (a.get("server") or {}).get("id") == srv["id"] for a in fw.get("applied_to") or [])
        if not on and not args.adopt_existing:
            raise Fail(f"{cfg.host} already exists and runs. Attaching {cfg.firewall} closes every port on it except 443/ICMP/41641 "
                       "(including SSH, until infra/firewall-temp-ssh.sh add). Re-run with --adopt-existing to accept that.")
        if have_type != cfg.server_type:
            warn(f"{cfg.host} is {have_type}, [infra.hetzner] server_type says {cfg.server_type}. Not changed: a rescale "
                 "moves the server to Hetzner's current price list. Update tenant.toml to match, or resize in the Console.")
        say("An adopted server was not built with infra/cloud-init.yaml. Next: infra/firewall-temp-ssh.sh add (SSH is closed now), "
            "then infra/server/bootstrap-existing.sh --confirm.")
    else:
        if not args.user_data or not Path(args.user_data).is_file():
            raise Fail("internal: rendered user-data file missing")
        body = {
            "name": cfg.host, "server_type": cfg.server_type, "image": cfg.image, "location": cfg.location,
            "ssh_keys": [key["id"]], "user_data": Path(args.user_data).read_text(encoding="utf-8"),
            "labels": {**cfg.labels, "pd-role": "drive"}, "firewalls": [{"firewall": fw["id"]}],
            "public_net": {"enable_ipv4": True, "enable_ipv6": True}, "start_after_create": True,
        }
        res = api.call("POST", "/servers", body)
        srv = res["server"]
        api.wait(res.get("action"), "server create")
        for a in res.get("next_actions") or []:
            api.wait(a, "server start")
        srv = api.find("servers", cfg.host) or srv
        fw = api.find("firewalls", cfg.firewall) or fw
        say("created")
    # firewall applied?
    applied = {a.get("server", {}).get("id") for a in (fw.get("applied_to") or []) if a.get("type") == "server"}
    if srv["id"] not in applied:
        res = api.call("POST", f"/firewalls/{fw['id']}/actions/apply_to_resources",
                       {"apply_to": [{"type": "server", "server": {"id": srv["id"]}}]})
        for a in res.get("actions") or []:
            api.wait(a, "apply firewall")
        say(f"firewall {cfg.firewall} applied to {cfg.host}")

    # 4. Volumes
    if storage == "volumes":
        for role, (name, size) in cfg.vol.items():
            say(f"== Volume: {name} ({size} GB)")
            v = api.find("volumes", name)
            if not v:
                # No format, no automount (the API ties automount to `server`): the volume stays blank (plan 01).
                res = api.call("POST", "/volumes", {"name": name, "size": size, "location": location_of(srv),
                                                    "labels": {**cfg.labels, "pd-role": role}})
                v = res["volume"]
                api.wait(res.get("action"), f"create volume {name}")
                say("created (no filesystem: LUKS is plan 01)")
            else:
                if location_of(v) != location_of(srv):
                    raise Fail(f"volume {name} is in {location_of(v)}, the server in {location_of(srv)}")
                if int(v.get("size", 0)) < size:
                    warn(f"volume {name} is {v.get('size')} GB, tenant.toml says {size} GB (grow: infra/volume-extend.sh)")
            if v.get("server") is None:
                api.wait(api.call("POST", f"/volumes/{v['id']}/actions/attach",
                                  {"server": srv["id"], "automount": False}).get("action"), f"attach {name}")
                say("attached")
            elif v.get("server") != srv["id"]:
                raise Fail(f"volume {name} is attached to another server ({v.get('server')})")
            if not (v.get("protection") or {}).get("delete"):
                api.wait(api.call("POST", f"/volumes/{v['id']}/actions/change_protection", {"delete": True}).get("action"),
                         f"protect {name}")

    # 5. Protection
    prot = srv.get("protection") or {}
    if not (prot.get("delete") and prot.get("rebuild")):
        api.wait(api.call("POST", f"/servers/{srv['id']}/actions/change_protection",
                          {"delete": True, "rebuild": True}).get("action"), "server protection")
        say("server delete + rebuild protection on")
    if srv.get("backup_window"):
        warn("Hetzner backups are ON for this server: turn them off in the Console (they copy the LUKS keyfiles, D-138)")
    v4, v6 = addresses_of(srv)
    say("")
    say(f"server IPv4 : {v4}")
    say(f"server IPv6 : {v6}   (verify on the server: ip -6 addr)")
    say(f"STATE.md: | {time.strftime('%Y-%m-%d')} | 01 | §2 Hetzner resources | done | {cfg.host} {v4} / {v6} "
        f"({(srv.get('server_type') or {}).get('name', cfg.server_type)}, {location_of(srv)}); fw {cfg.firewall}; storage {storage} |")
    return 0


# ------------------------------------------------------------------ small verbs
def cmd_addresses(_: argparse.Namespace) -> int:
    cfg = Cfg()
    print(*addresses_of(server_or_die(Api(dry=False), cfg)))
    return 0


def firewall_or_none(api: Api, cfg: Cfg) -> dict[str, Any] | None:
    return api.find("firewalls", cfg.firewall)


def attached_firewalls(api: Api, srv: dict[str, Any]) -> list[dict[str, Any]]:
    """Every firewall that filters this server. Hetzner adds up the rules of all attached firewalls, so a
    check that reads only fw-pd could miss an SSH rule in another one (review finding 1)."""
    ids = {f.get("id") for f in ((srv.get("public_net") or {}).get("firewalls") or [])}
    out = []
    for fw in api.list_all("firewalls"):
        on = any(a.get("type") == "server" and (a.get("server") or {}).get("id") == srv["id"]
                 for a in fw.get("applied_to") or [])
        if on or fw.get("id") in ids:
            out.append(fw)
    return out


def ssh_exposure(api: Api, cfg: Cfg, srv: dict[str, Any]) -> list[str]:
    """Problems that leave or could leave SSH reachable from the internet, one line each. Empty = none.
    Lines are "<firewall>:<index>\t<summary>" for TCP 22 rules, "-\t<problem>" for attachment problems."""
    fws = attached_firewalls(api, srv)
    lines: list[str] = []
    if not any(fw.get("name") == cfg.firewall for fw in fws):
        lines.append(f"-\tfirewall {cfg.firewall} is NOT attached to {cfg.host} (infra/provision.sh)")
    for fw in fws:
        if fw.get("name") != cfg.firewall:
            lines.append(f"-\tother firewall {fw.get('name')!r} is attached to {cfg.host}: detach it (only {cfg.firewall} may filter PD)")
        for i, r in enumerate(fw.get("rules", [])):
            if covers_tcp22(r):
                lines.append(f"{fw.get('name')}:{i}\t{summary(r)}")
    return lines


def cmd_ssh_rules(_: argparse.Namespace) -> int:
    cfg = Cfg()
    api = Api(dry=False)
    for line in ssh_exposure(api, cfg, server_or_die(api, cfg)):
        print(line)
    return 0


def cmd_temp_ssh(args: argparse.Namespace) -> int:
    cfg = Cfg()
    api = Api(dry=False)
    fw = firewall_or_none(api, cfg)
    if not fw:
        raise Fail(f"firewall {cfg.firewall} does not exist (run infra/provision.sh first)")
    rules = list(fw.get("rules", []))
    if args.action == "add":
        if any(is_temp_ssh(r) and r["source_ips"] == [args.cidr] for r in rules):
            say(f"TCP 22 from {args.cidr} already present")
            return 0
        rules.append({"direction": "in", "protocol": "tcp", "port": "22", "source_ips": [args.cidr],
                      "description": f"{TEMP_SSH_TAG} created={int(time.time())}"})
        say(f"adding TCP 22 from {args.cidr} to {cfg.firewall}")
    else:
        before = len(rules)
        rules = [r for r in rules if not covers_tcp22(r)]
        if before == len(rules):
            say("no TCP 22 rule present")
    for a in api.call("POST", f"/firewalls/{fw['id']}/actions/set_rules", {"rules": rules}).get("actions") or []:
        api.wait(a, "set firewall rules")
    if args.action == "remove":
        left = [r for r in (api.find("firewalls", cfg.firewall) or {}).get("rules", []) if covers_tcp22(r)]
        if left:
            raise Fail(f"TCP 22 rule(s) still present: {'; '.join(summary(r) for r in left)}")
        say(f"VERIFIED: no TCP 22 rule left in {cfg.firewall}")
    return 0


def cmd_status(_: argparse.Namespace) -> int:
    cfg = Cfg()
    s = server_or_die(Api(dry=False), cfg)
    p = s.get("protection") or {}
    say(f"{cfg.host}: status={s.get('status')} rescue={s.get('rescue_enabled')} type={(s.get('server_type') or {}).get('name')} "
        f"location={location_of(s)} protection(delete={p.get('delete')}, rebuild={p.get('rebuild')}) "
        f"firewalls={[f.get('id') for f in ((s.get('public_net') or {}).get('firewalls') or [])]}")
    return 0


def cmd_console(_: argparse.Namespace) -> int:
    cfg = Cfg()
    s = server_or_die(Api(dry=False), cfg)
    say(f"Open the Hetzner Console > project > Servers > {cfg.host} (id {s['id']}) > Console (the >_ icon).")
    say("Log in as the admin user with the password from the password manager. The console password the API "
        "could issue is not printed here on purpose.")
    return 0


def cmd_rescue(args: argparse.Namespace) -> int:
    cfg = Cfg()
    if not args.confirm_reboot:
        raise Fail("rescue reboots the server (PD is down) into a system with no host firewall that sees the "
                   "LUKS keyfiles. Re-run with --confirm-reboot, then ALWAYS run `unrescue`.")
    api = Api(dry=False)
    s = server_or_die(api, cfg)
    exposure = ssh_exposure(api, cfg, s)
    want = f"from {args.cidr} "
    stray = [ln for ln in exposure if want not in ln]
    if stray or len(exposure) != 1:
        raise Fail(f"rescue needs {cfg.firewall} attached alone with exactly one TCP 22 rule, from {args.cidr} "
                   f"(infra/firewall-temp-ssh.sh add first); found: {'; '.join(exposure) or 'no TCP 22 rule'}")
    key = api.find("ssh_keys", cfg.key_name)
    if not key:
        raise Fail(f"ssh key {cfg.key_name} not in the project: rescue would fall back to a root password")
    res = api.call("POST", f"/servers/{s['id']}/actions/enable_rescue", {"type": "linux64", "ssh_keys": [key["id"]]})
    api.wait(res.get("action"), "enable rescue")
    api.wait(api.call("POST", f"/servers/{s['id']}/actions/reset").get("action"), "reset into rescue")
    say(f"{cfg.host} is booting the rescue system (key login as root, from {args.cidr} only). Run `unrescue` when done.")
    return 0


def cmd_unrescue(_: argparse.Namespace) -> int:
    cfg = Cfg()
    api = Api(dry=False)
    s = server_or_die(api, cfg)
    if s.get("rescue_enabled"):
        api.wait(api.call("POST", f"/servers/{s['id']}/actions/disable_rescue").get("action"), "disable rescue")
    api.wait(api.call("POST", f"/servers/{s['id']}/actions/reboot").get("action"), "reboot")
    say(f"{cfg.host}: rescue off, rebooting into its own system. Then: infra/firewall-temp-ssh.sh remove --check-host <tailnet name>")
    return 0


def cmd_volume_ids(_: argparse.Namespace) -> int:
    cfg = Cfg()
    if cfg.storage != "volumes":
        raise Fail("[infra] storage = root-container: there are no provider volumes (identify-volumes.sh --root-container)")
    api = Api(dry=False)
    for role, (name, _size) in cfg.vol.items():
        v = api.find("volumes", name)
        if not v:
            raise Fail(f"volume {name} not found")
        print(f"{role} {v['id']}")
    return 0


def cmd_volume_extend(args: argparse.Namespace) -> int:
    cfg = Cfg()
    name, _ = cfg.vol[args.volume]
    say(f"grow {name} to {args.size} GB (online; Hetzner volumes grow, never shrink). Then on the server: "
        f"sudo infra/luks/grow-volume.sh --volume {args.volume}")
    if args.dry_run:
        return 0
    if not args.confirm_purchase:
        raise Fail("a bigger volume costs more: re-run with --confirm-purchase")
    api = Api(dry=False)
    v = api.find("volumes", name)
    if not v:
        raise Fail(f"volume {name} not found")
    if int(v["size"]) >= args.size:
        raise Fail(f"{name} is already {v['size']} GB; volumes never shrink")
    api.wait(api.call("POST", f"/volumes/{v['id']}/actions/resize", {"size": args.size}).get("action"), f"resize {name}")
    say(f"{name} is now {args.size} GB. Update [volumes] {args.volume}_size_gb in tenant.toml.")
    return 0


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(prog="hapi.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("provision")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--confirm-purchase", action="store_true")
    p.add_argument("--user-data")
    p.add_argument("--storage", choices=["volumes", "root-container"])
    p.add_argument("--adopt-existing", action="store_true")
    for n in ("addresses", "ssh-rules", "status", "console", "unrescue", "volume-ids"):
        sub.add_parser(n)
    p = sub.add_parser("temp-ssh")
    p.add_argument("action", choices=["add", "remove"])
    p.add_argument("--cidr", default="")
    p = sub.add_parser("rescue")
    p.add_argument("--confirm-reboot", action="store_true")
    p.add_argument("--cidr", required=True)
    p = sub.add_parser("volume-extend")
    p.add_argument("--volume", choices=["data", "backup"], required=True)
    p.add_argument("--size", type=int, required=True)
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--confirm-purchase", action="store_true")
    args = ap.parse_args(argv)
    if args.cmd == "temp-ssh" and args.action == "add" and not args.cidr:
        ap.error("temp-ssh add needs --cidr")
    fn = {"provision": cmd_provision, "addresses": cmd_addresses, "ssh-rules": cmd_ssh_rules,
          "temp-ssh": cmd_temp_ssh, "status": cmd_status, "console": cmd_console, "rescue": cmd_rescue,
          "unrescue": cmd_unrescue, "volume-ids": cmd_volume_ids, "volume-extend": cmd_volume_extend}[args.cmd]
    try:
        return fn(args)
    except (Fail, tenant.TenantError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
