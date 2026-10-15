#!/usr/bin/env python3
"""OpenStack JSON helpers for infra/providers/ovh-us/*.sh and ops/restore-drill/drill.sh (no network, no secrets).

Implements: docs/plans/01-infrastructure.md s3 (rules of the security group, Drive D-135),
section 4 step 3 (no TCP 22 rule may remain once the admin network works) and the address read-out
for DNS (section 3).

Security-group rules are read from `openstack security group show <group> -f json` (its "rules" list
carries the raw Neutron fields: direction, ethertype, protocol, port_range_min/max, remote_ip_prefix,
description, created_at) or `openstack security group rule list <group> -f json` (columns ID, IP
Protocol, Ethertype, IP Range, Port Range "22:22", Direction; no description or age). Both shapes are
accepted, so a client version change does not break the checks.

Subcommands (JSON on stdin where noted):
  sg-desired              the s3 ingress rules, one TAB-separated line each:
                          ethertype, protocol, port ("-" = none), remote CIDR, description
  sg-missing              stdin: rule list. Desired ingress rules that are absent (same line format)
  sg-drift                stdin: rule list. exit 0 = ingress rules are exactly the desired set plus at
                          most single-IP temporary TCP 22 rules (each printed as a WARN line with its
                          age); exit 1 = differences printed. Also reports a missing allow-all egress rule
  sg-ssh-rules [--except CIDR]
                          stdin: rule list. One line per ingress rule covering TCP 22: "<id>\t<summary>";
                          --except leaves out a single-IP rule for exactly that /32 or /128
  sg-stale-ssh HOURS      stdin: `security group show` JSON. TCP 22 rules that are not single-IP, older
                          than HOURS, or of unknown age (one line each); exit 0 always
  sg-has-ssh <cidr>       stdin: rule list. exit 0 if an ingress TCP 22 rule from exactly that CIDR exists
  addresses <network>     stdin: `server show -f json`. Prints "<ipv4> <ipv6>" on that network ("-" if none)
  props <key>             stdin: an object with "properties" (dict, or "k='v', ..." text). Prints the value
  tailnet-addr <host>     resolve host (or accept an IP) and print the first address inside
                          100.64.0.0/10 or fd7a:115c:a1e0::/48; exit 1 (message on stderr) if none
  cidr <ip>               validate an admin IP and print it as /32 or /128 (rejects non-public)
"""
from __future__ import annotations

import ipaddress
import json
import re
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "lib"))
from netutil import cmd_cidr, cmd_tailnet_addr

ANY = {"IPv4": "0.0.0.0/0", "IPv6": "::/0"}
ICMP = {"IPv4": "icmp", "IPv6": "ipv6-icmp"}


def desired_rules() -> list[dict[str, Any]]:
    """Plan 01 s3: 443, ICMP, UDP 41641 from anywhere (no port 80: Cloudflare terminates HTTP), IPv4 and IPv6. No TCP 22."""
    out: list[dict[str, Any]] = []
    for eth in ("IPv4", "IPv6"):
        out += [
            {"ethertype": eth, "protocol": "tcp", "port": "443", "remote": ANY[eth], "description": "HTTPS"},
            {"ethertype": eth, "protocol": ICMP[eth], "port": "", "remote": ANY[eth], "description": "Ping, path MTU"},
            {"ethertype": eth, "protocol": "udp", "port": "41641", "remote": ANY[eth],
             "description": "Tailscale direct connections (optional; DERP works without it)"},
        ]
    return out


def norm_proto(p: Any) -> str:
    text = "" if p in (None, "", "any") else str(p).lower()
    return {"1": "icmp", "6": "tcp", "17": "udp", "58": "ipv6-icmp", "icmpv6": "ipv6-icmp"}.get(text, text)


def norm(rule: dict[str, Any]) -> dict[str, Any]:
    """One rule in either CLI-table or Neutron shape -> {id, direction, ethertype, protocol, lo, hi, remote}."""
    if "Direction" in rule or "IP Protocol" in rule:
        rng = str(rule.get("Port Range") or "")
        lo = hi = None
        m = re.fullmatch(r"(\d+):(\d+)", rng)
        if m:
            lo, hi = int(m.group(1)), int(m.group(2))
        remote = rule.get("IP Range")
        return {"id": rule.get("ID"), "direction": rule.get("Direction"), "ethertype": rule.get("Ethertype"),
                "protocol": norm_proto(rule.get("IP Protocol")), "lo": lo, "hi": hi, "remote": remote,
                "remote_group": rule.get("Remote Security Group"), "description": rule.get("Description")}
    lo, hi = rule.get("port_range_min"), rule.get("port_range_max")
    return {"id": rule.get("id"), "direction": rule.get("direction"),
            "ethertype": rule.get("ethertype") or rule.get("ether_type"),
            "protocol": norm_proto(rule.get("protocol")),
            "lo": int(lo) if lo not in (None, "") else None, "hi": int(hi) if hi not in (None, "") else None,
            "remote": rule.get("remote_ip_prefix"), "remote_group": rule.get("remote_group_id"),
            "description": rule.get("description"), "created_at": rule.get("created_at")}


def age_hours(r: dict[str, Any]) -> float | None:
    """Age from our description stamp (created=<epoch>), else Neutron's created_at; None if unknown."""
    m = re.search(r"created=(\d{9,})", str(r.get("description") or ""))
    if m:
        return (time.time() - int(m.group(1))) / 3600
    ts = r.get("created_at")
    if ts:
        try:
            return (time.time() - datetime.fromisoformat(str(ts)).timestamp()) / 3600
        except ValueError:
            return None
    return None


def rules_of(doc: Any) -> list[dict[str, Any]]:
    if isinstance(doc, dict):
        doc = doc.get("rules") or doc.get("security_group_rules") or []
    return [norm(r) for r in doc or []]


def remote_of(r: dict[str, Any]) -> str:
    """Neutron leaves remote_ip_prefix empty for 'from anywhere' (when no remote group is set)."""
    if r.get("remote"):
        return str(r["remote"])
    return ANY.get(str(r.get("ethertype")), "") if not r.get("remote_group") else "group:" + str(r["remote_group"])


def covers_tcp22(r: dict[str, Any]) -> bool:
    if r.get("direction") != "ingress" or r.get("protocol") not in ("tcp", ""):
        return False  # "" = any protocol, which includes TCP
    if r.get("lo") is None and r.get("hi") is None:
        return True
    lo = r["lo"] if r.get("lo") is not None else r["hi"]
    hi = r["hi"] if r.get("hi") is not None else r["lo"]
    return int(lo) <= 22 <= int(hi)


def is_single_ip_temp(r: dict[str, Any]) -> bool:
    if r.get("protocol") != "tcp" or r.get("lo") != 22 or r.get("hi") != 22:
        return False
    try:
        return ipaddress.ip_network(remote_of(r), strict=False).num_addresses == 1
    except ValueError:
        return False


def key(r: dict[str, Any]) -> tuple[str, str, str, str]:
    port = "" if r.get("lo") is None else (str(r["lo"]) if r.get("lo") == r.get("hi") else f"{r['lo']}-{r['hi']}")
    return (str(r.get("ethertype")), str(r.get("protocol")), port, remote_of(r))


def dkey(d: dict[str, Any]) -> tuple[str, str, str, str]:
    return (d["ethertype"], d["protocol"], d["port"], d["remote"])


def line(d: dict[str, Any]) -> str:
    return "\t".join((d["ethertype"], d["protocol"], d["port"] or "-", d["remote"], d["description"]))


def summary(r: dict[str, Any]) -> str:
    port = "any" if r.get("lo") is None else f"{r['lo']}-{r['hi']}"
    return f"{r.get('direction')} {r.get('ethertype')} {r.get('protocol') or 'any'} port {port} from {remote_of(r)}"


def cmd_drift(rules: list[dict[str, Any]]) -> int:
    want = {dkey(d) for d in desired_rules()}
    ingress = [r for r in rules if r.get("direction") == "ingress"]
    have = {key(r) for r in ingress if not covers_tcp22(r)}
    problems = [f"missing rule: {k}" for k in sorted(want - have)]
    problems += [f"unexpected rule: {k}" for k in sorted(have - want)]
    problems += [f"port 22 rule that is not a single-IP temporary rule: {summary(r)}"
                 for r in ingress if covers_tcp22(r) and not is_single_ip_temp(r)]
    for r in ingress:
        if covers_tcp22(r) and is_single_ip_temp(r):
            age = age_hours(r)
            print(f"WARN temporary SSH rule still present: {summary(r)}, age "
                  f"{'unknown' if age is None else f'{age:.1f} h'} (remove: infra/providers/ovh-us/firewall-temp-ssh.sh remove)")
    egress = {r.get("ethertype") for r in rules if r.get("direction") == "egress" and not r.get("protocol")
              and r.get("lo") is None and remote_of(r) == ANY.get(str(r.get("ethertype")))}
    problems += [f"missing allow-all egress rule for {e} (outbound must stay open, plan 01)"
                 for e in ("IPv4", "IPv6") if e not in egress]
    for p in problems:
        print(p)
    return 1 if problems else 0


def cmd_addresses(doc: dict[str, Any], network: str) -> int:
    addrs = doc.get("addresses") or {}
    if isinstance(addrs, str):  # very old clients: "Ext-Net=1.2.3.4, 2001:db8::1"
        parsed: dict[str, list[str]] = {}
        for part in addrs.split(";"):
            if "=" in part:
                net, ips = part.split("=", 1)
                parsed[net.strip()] = [i.strip() for i in ips.split(",") if i.strip()]
        addrs = parsed
    ips = [a["addr"] if isinstance(a, dict) else str(a) for a in addrs.get(network, [])]
    v4 = next((i for i in ips if ipaddress.ip_address(i).version == 4), "-")
    v6 = next((i for i in ips if ipaddress.ip_address(i).version == 6), "-")
    print(f"{v4} {v6}")
    return 0 if v4 != "-" else 1


def props(value: Any) -> dict[str, str]:
    if isinstance(value, dict):
        return {str(k): str(v) for k, v in value.items()}
    if not value:
        return {}
    return dict(re.findall(r"([A-Za-z0-9_.:-]+)='([^']*)'", str(value)))


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__, file=sys.stderr)
        return 2
    cmd, rest = argv[0], argv[1:]
    if cmd == "sg-desired":
        print("\n".join(line(d) for d in desired_rules()))
        return 0
    if cmd == "cidr":
        return cmd_cidr(rest[0]) if rest else 2
    if cmd == "tailnet-addr":
        return cmd_tailnet_addr(rest[0]) if rest else 2
    doc = json.load(sys.stdin)
    if cmd == "addresses":
        return cmd_addresses(doc, rest[0]) if rest else 2
    if cmd == "props":
        if not rest:
            return 2
        print(props((doc or {}).get("properties")).get(rest[0], ""))
        return 0
    rules = rules_of(doc)
    if cmd == "sg-missing":
        have = {key(r) for r in rules if r.get("direction") == "ingress"}
        for d in desired_rules():
            if dkey(d) not in have:
                print(line(d))
        return 0
    if cmd == "sg-drift":
        return cmd_drift(rules)
    if cmd == "sg-ssh-rules":
        keep = rest[1] if len(rest) >= 2 and rest[0] == "--except" else None
        for r in rules:
            if covers_tcp22(r) and not (keep and is_single_ip_temp(r) and remote_of(r) == keep):
                print(f"{r.get('id')}\t{summary(r)}")
        return 0
    if cmd == "sg-stale-ssh":
        if not rest:
            return 2
        limit = float(rest[0])
        for r in rules:
            if not covers_tcp22(r):
                continue
            age = age_hours(r)
            if not is_single_ip_temp(r) or age is None or age > limit:
                print(f"{r.get('id')}\t{summary(r)}, age {'unknown' if age is None else f'{age:.1f} h'}")
        return 0
    if cmd == "sg-has-ssh":
        if not rest:
            return 2
        return 0 if any(covers_tcp22(r) and is_single_ip_temp(r) and remote_of(r) == rest[0] for r in rules) else 1
    print(f"unknown subcommand {cmd}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
