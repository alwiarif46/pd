#!/usr/bin/env python3
"""Fake `openstack` CLI for the offline tests (infra/tests, ops/tests). No network, no secrets.

State: JSON file $FAKE_OS_STATE with lists servers, volumes, security_groups (each with neutron-style
rules), keypairs, ports and project_id. Missing file = empty project. Every call is appended to
$FAKE_CALLS as "openstack <args>" (the environment is never logged). $FAKE_OS_FAIL: a regex; a call
whose joined argv matches it exits 1. Implements only the subcommands the pd scripts use, with
the output shapes of python-openstackclient 10.x (-f json / -f value -c COL).
"""
from __future__ import annotations

import json
import os
import re
import sys
import uuid

argv = sys.argv[1:]
with open(os.environ.get("FAKE_CALLS", os.devnull), "a", encoding="utf-8") as fh:
    fh.write("openstack " + " ".join(argv) + "\n")
if os.environ.get("FAKE_OS_FAIL") and re.search(os.environ["FAKE_OS_FAIL"], " ".join(argv)):
    print("fake failure", file=sys.stderr)
    sys.exit(1)

STATE = os.environ.get("FAKE_OS_STATE", "")
st: dict = {"servers": [], "volumes": [], "security_groups": [], "keypairs": [], "ports": [], "project_id": "p0"}
if STATE and os.path.exists(STATE):
    with open(STATE, encoding="utf-8") as fh:
        st.update(json.load(fh))


def save() -> None:
    if STATE:
        with open(STATE, "w", encoding="utf-8") as fh:
            json.dump(st, fh, indent=1)


# global options
while argv and argv[0].startswith("--os-"):
    argv = argv[2:] if "=" not in argv[0] else argv[1:]

fmt, cols, opts, pos = "table", [], {}, []
i = 0
MULTI = {"--property", "--security-group"}
FLAGS = {"--wait", "--ingress", "--egress", "--novnc", "--long"}
while i < len(argv):
    a = argv[i]
    if a == "-f":
        fmt = argv[i + 1]; i += 2; continue
    if a == "-c":
        cols.append(argv[i + 1]); i += 2; continue
    if a in FLAGS:
        opts[a] = True; i += 1; continue
    if a.startswith("--"):
        val = argv[i + 1] if i + 1 < len(argv) else ""
        if a in MULTI:
            opts.setdefault(a, []).append(val)
        else:
            opts[a] = val
        i += 2; continue
    pos.append(a); i += 1


def out(obj, rows=False):
    if fmt == "json":
        print(json.dumps(obj))
    elif fmt == "value":
        items = obj if rows else [obj]
        for it in items:
            print(" ".join(str(it.get(c, "")) if not isinstance(it.get(c), (dict, list)) else json.dumps(it.get(c)) for c in cols))
    else:
        print(json.dumps(obj))


def find(kind, ref):
    for r in st[kind]:
        if r.get("id") == ref or r.get("name") == ref:
            return r
    print(f"No {kind[:-1]} found for {ref}", file=sys.stderr)
    sys.exit(1)


def props(lst):
    return dict(p.split("=", 1) for p in lst or [])


def srv_view(s):
    return {"id": s["id"], "name": s["name"], "status": s.get("status", "ACTIVE"), "locked": s.get("locked", False),
            "properties": s.get("properties", {}), "addresses": s.get("addresses", {}),
            "security_groups": [{"name": n} for n in s.get("security_groups", [])]}


def rule_row(r):
    lo, hi = r.get("port_range_min"), r.get("port_range_max")
    rng = "" if lo is None and hi is None else f"{lo}:{hi}"
    return {"ID": r["id"], "IP Protocol": r.get("protocol"), "Ethertype": r.get("ethertype"),
            "IP Range": r.get("remote_ip_prefix"), "Port Range": rng, "Direction": r.get("direction"),
            "Remote Security Group": None, "Remote Address Group": None}


def unlocked(ref):
    """Nova refuses most actions on a locked server (HTTP 409) for a non-admin user."""
    s = find("servers", ref)
    if s.get("locked"):
        print(f"Instance {s['id']} is locked (HTTP 409)", file=sys.stderr)
        sys.exit(1)
    return s


NOW = __import__("datetime").datetime.now(__import__("datetime").timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
cmd = pos[:3]
res = 0
if pos[:2] == ["token", "issue"]:
    out({"project_id": st["project_id"], "id": "tok"})
elif pos[:2] == ["server", "list"]:
    rx = opts.get("--name")
    rows = [{"ID": s["id"], "Name": s["name"], "Status": s.get("status", "ACTIVE")} for s in st["servers"]
            if not rx or re.search(rx, s["name"])]
    out(rows, rows=True)
elif pos[:2] == ["server", "show"]:
    out(srv_view(find("servers", pos[2])))
elif pos[:2] == ["server", "create"]:
    name = pos[2]
    s = {"id": str(uuid.uuid4()), "name": name, "properties": props(opts.get("--property")), "locked": False,
         "security_groups": opts.get("--security-group") or ["default"],
         "addresses": {opts.get("--network", "Ext-Net"): ["203.0.113.50", "2001:db8::50"]}}
    if opts.get("--user-data") and os.path.exists(opts["--user-data"]):
        with open(opts["--user-data"], encoding="utf-8") as fh:
            s["user_data"] = fh.read()
    st["servers"].append(s)
    st["ports"].append({"id": "port-" + s["id"][:8], "server": s["id"], "port_security_enabled": os.environ.get("FAKE_OS_PORT_SECURITY", "True")})
    save(); out(srv_view(s))
elif pos[:2] == ["server", "delete"]:
    s = unlocked(pos[2]); st["servers"].remove(s)
    for v in st["volumes"]:
        v["attachments"] = [a for a in v.get("attachments", []) if a.get("server_id") != s["id"]]
    save()
elif pos[:4] == ["server", "add", "security", "group"]:
    s = unlocked(pos[4]); s["security_groups"].append(pos[5]); save()
elif pos[:4] == ["server", "remove", "security", "group"]:
    s = unlocked(pos[4]); s["security_groups"].remove(pos[5]); save()
elif pos[:3] == ["server", "add", "volume"]:
    s = unlocked(pos[3]); v = find("volumes", pos[4])
    v["attachments"] = [{"server_id": s["id"], "device": "/dev/sdb"}]; v["status"] = "in-use"; save()
elif pos[:3] == ["server", "remove", "volume"]:
    s = unlocked(pos[3]); v = find("volumes", pos[4])
    v["attachments"] = []; v["status"] = "available"; save()
elif pos[:2] in (["server", "lock"], ["server", "unlock"]):
    find("servers", pos[2])["locked"] = pos[1] == "lock"; save()
elif pos[:2] in (["server", "rescue"], ["server", "unrescue"], ["server", "resize"]):
    s = unlocked(pos[-1]); s["status"] = {"rescue": "RESCUE", "unrescue": "ACTIVE", "resize": "VERIFY_RESIZE"}[pos[1]]; save()
elif pos[:3] == ["console", "url", "show"]:
    out({"type": "novnc", "url": "https://console.example.invalid/vnc?token=fake"})
elif pos[:2] == ["port", "list"]:
    s = find("servers", opts["--server"])
    out([{"ID": p["id"]} for p in st["ports"] if p["server"] == s["id"]], rows=True)
elif pos[:2] == ["port", "show"]:
    out(next(p for p in st["ports"] if p["id"] == pos[2]))
elif pos[:2] == ["keypair", "show"]:
    k = find("keypairs", pos[2]); out(k)
elif pos[:2] == ["keypair", "create"]:
    st["keypairs"].append({"name": pos[2], "fingerprint": "aa:bb"}); save()
elif pos[:3] == ["security", "group", "show"]:
    out(find("security_groups", pos[3]))
elif pos[:3] == ["security", "group", "list"]:
    rows = [{"ID": g["id"], "Name": g["name"], "Description": g.get("description", "")} for g in st["security_groups"]]
    out(rows, rows=True)
elif pos[:3] == ["security", "group", "create"]:
    g = {"id": str(uuid.uuid4()), "name": pos[3], "description": opts.get("--description", ""), "rules": [
        {"id": str(uuid.uuid4()), "direction": "egress", "ethertype": e, "protocol": None,
         "port_range_min": None, "port_range_max": None, "remote_ip_prefix": None, "created_at": NOW} for e in ("IPv4", "IPv6")]}
    st["security_groups"].append(g); save(); out(g)
elif pos[:3] == ["security", "group", "delete"]:
    g = find("security_groups", pos[3])
    if any(g["name"] in s.get("security_groups", []) for s in st["servers"]):
        print("Security group in use", file=sys.stderr); sys.exit(1)
    st["security_groups"].remove(g); save()
elif pos[:4] == ["security", "group", "rule", "list"]:
    g = find("security_groups", pos[4])
    out([rule_row(r) for r in g["rules"]], rows=True)
elif pos[:4] == ["security", "group", "rule", "create"]:
    g = find("security_groups", pos[4])
    port = opts.get("--dst-port")
    r = {"id": str(uuid.uuid4()), "direction": "egress" if opts.get("--egress") else "ingress",
         "ethertype": opts.get("--ethertype", "IPv4"), "protocol": opts.get("--protocol"),
         "port_range_min": int(port.split(":")[0]) if port else None,
         "port_range_max": int(port.split(":")[-1]) if port else None,
         "remote_ip_prefix": opts.get("--remote-ip"), "description": opts.get("--description", ""), "created_at": NOW}
    g["rules"].append(r); save(); out(r)
elif pos[:4] == ["security", "group", "rule", "delete"]:
    for g in st["security_groups"]:
        g["rules"] = [r for r in g["rules"] if r["id"] != pos[4]]
    save()
elif pos[:2] == ["volume", "list"]:
    want = props(opts.get("--property"))
    rows = [{"ID": v["id"], "Name": v["name"], "Status": v.get("status", "available"), "Size": v.get("size")}
            for v in st["volumes"] if (not opts.get("--name") or v["name"] == opts["--name"])
            and all(v.get("properties", {}).get(k) == x for k, x in want.items())]
    out(rows, rows=True)
elif pos[:2] == ["volume", "show"]:
    out(find("volumes", pos[2]))
elif pos[:2] == ["volume", "create"]:
    v = {"id": str(uuid.uuid4()), "name": pos[2], "size": int(opts["--size"]), "type": opts.get("--type"),
         "status": "available", "properties": props(opts.get("--property")), "attachments": []}
    st["volumes"].append(v); save(); out(v)
elif pos[:2] == ["volume", "set"]:
    v = find("volumes", pos[2])
    if "--size" in opts:
        v["size"] = int(opts["--size"])
    v.setdefault("properties", {}).update(props(opts.get("--property")))
    save()
elif pos[:2] == ["volume", "delete"]:
    v = find("volumes", pos[2])
    if v.get("attachments"):
        print("Volume is in-use", file=sys.stderr); sys.exit(1)
    st["volumes"].remove(v); save()
else:
    print(f"fake openstack: unsupported command {' '.join(argv)}", file=sys.stderr)
    res = 2
sys.exit(res)
