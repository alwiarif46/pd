#!/usr/bin/env python3
"""Fake Hetzner Cloud API v1 for infra/tests/run-tests.sh (no network beyond 127.0.0.1).

Usage: hcloud_fake.py STATE.json CALLS.log PORTFILE TOKEN
  Serves http://127.0.0.1:<port>/v1, writes the port to PORTFILE, keeps state in STATE.json (seed it before
  starting; re-read on every request so a test can edit it), appends "METHOD PATH auth=ok|BAD" per request to
  CALLS.log (the token itself is never written). Implements only what infra/providers/hetzner/hapi.py
  calls: list/find by name, create firewall/server/volume/ssh key, the firewall/server/volume actions it
  uses, and GET /actions/<id> (every action finishes at once). Unknown routes answer 404 in the API's
  error shape. A request with a wrong token answers 401.
"""
from __future__ import annotations

import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

STATE, CALLS, PORTFILE, TOKEN = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]), sys.argv[4]
LOCK = threading.Lock()


def load() -> dict:
    if STATE.exists():
        d = json.loads(STATE.read_text() or "{}")
    else:
        d = {}
    for k in ("servers", "firewalls", "volumes", "ssh_keys"):
        d.setdefault(k, [])
    d.setdefault("next_id", 1000)
    return d


def save(d: dict) -> None:
    STATE.write_text(json.dumps(d, indent=1))


def new_id(d: dict) -> int:
    d["next_id"] += 1
    return d["next_id"]


def action(d: dict, cmd: str) -> dict:
    return {"id": new_id(d), "command": cmd, "status": "running"}


class H(BaseHTTPRequestHandler):
    def log_message(self, *_: object) -> None:  # quiet
        pass

    def reply(self, code: int, body: dict) -> None:
        raw = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def err(self, code: int, kind: str, msg: str) -> None:
        self.reply(code, {"error": {"code": kind, "message": msg, "details": {}}})

    def handle_any(self, method: str) -> None:
        u = urlparse(self.path)
        auth_ok = self.headers.get("Authorization") == f"Bearer {TOKEN}"
        with LOCK, CALLS.open("a") as fh:
            fh.write(f"{method} {u.path} auth={'ok' if auth_ok else 'BAD'}\n")
        if not auth_ok:
            return self.err(401, "unauthorized", "unable to authenticate")
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}") if n else {}
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        parts = [p for p in u.path.split("/") if p][1:]  # drop "v1"
        with LOCK:
            d = load()
            try:
                code, out = self.route(d, method, parts, q, body)
            except KeyError as exc:
                code, out = 404, {"error": {"code": "not_found", "message": str(exc)}}
            save(d)
        self.reply(code, out)

    def do_GET(self) -> None:
        self.handle_any("GET")

    def do_POST(self) -> None:
        self.handle_any("POST")

    def do_PUT(self) -> None:
        self.handle_any("PUT")

    def do_DELETE(self) -> None:
        self.handle_any("DELETE")

    # ------------------------------------------------------------------ routes
    def route(self, d: dict, m: str, p: list[str], q: dict, b: dict) -> tuple[int, dict]:
        kinds = ("servers", "firewalls", "volumes", "ssh_keys")
        if m == "GET" and len(p) == 2 and p[0] == "actions":
            return 200, {"action": {"id": int(p[1]), "status": "success"}}
        if m == "GET" and len(p) == 1 and p[0] in kinds:
            items = [i for i in d[p[0]] if "name" not in q or i.get("name") == q["name"]]
            return 200, {p[0]: items, "meta": {"pagination": {"page": 1, "next_page": None}}}
        if m == "POST" and len(p) == 1 and p[0] in kinds:
            return self.create(d, p[0], b)
        if m == "POST" and len(p) == 4 and p[0] in kinds and p[2] == "actions":
            obj = next((i for i in d[p[0]] if i["id"] == int(p[1])), None)
            if obj is None:
                raise KeyError(f"{p[0]} {p[1]}")
            return self.act(d, p[0], obj, p[3], b)
        raise KeyError(f"{m} /{'/'.join(p)}")

    def create(self, d: dict, kind: str, b: dict) -> tuple[int, dict]:
        if any(i.get("name") == b.get("name") for i in d[kind]):
            return 409, {"error": {"code": "uniqueness_error", "message": "name is already used"}}
        i = new_id(d)
        if kind == "firewalls":
            fw = {"id": i, "name": b["name"], "labels": b.get("labels", {}), "rules": b.get("rules", []),
                  "applied_to": [{"type": "server", "server": {"id": a["server"]["id"]}} for a in b.get("apply_to", [])]}
            d[kind].append(fw)
            return 201, {"firewall": fw, "actions": []}
        if kind == "ssh_keys":
            k = {"id": i, "name": b["name"], "public_key": b["public_key"], "fingerprint": "aa:bb"}
            d[kind].append(k)
            return 201, {"ssh_key": k}
        if kind == "volumes":
            v = {"id": i, "name": b["name"], "size": b["size"], "server": None, "labels": b.get("labels", {}),
                 "location": {"name": b.get("location", "ash")}, "protection": {"delete": False}}
            d[kind].append(v)
            return 201, {"volume": v, "action": action(d, "create_volume")}
        # servers
        s = {"id": i, "name": b["name"], "status": "running", "server_type": {"name": b["server_type"]},
             "datacenter": {"location": {"name": b["location"]}}, "labels": b.get("labels", {}),
             "public_net": {"ipv4": {"ip": "203.0.113.70"}, "ipv6": {"ip": "2001:db8:70::/64"}, "firewalls": []},
             "protection": {"delete": False, "rebuild": False}, "rescue_enabled": False, "backup_window": None,
             "user_data_seen": "table inet pd_fw" in b.get("user_data", "")}
        d[kind].append(s)
        for f in b.get("firewalls", []):
            fw = next(x for x in d["firewalls"] if x["id"] == f["firewall"])
            fw["applied_to"].append({"type": "server", "server": {"id": i}})
        return 201, {"server": s, "action": action(d, "create_server"), "root_password": None}

    def act(self, d: dict, kind: str, obj: dict, name: str, b: dict) -> tuple[int, dict]:
        if kind == "firewalls" and name == "set_rules":
            obj["rules"] = b["rules"]
            return 201, {"actions": [action(d, "set_firewall_rules")]}
        if kind == "firewalls" and name == "apply_to_resources":
            for a in b["apply_to"]:
                obj["applied_to"].append({"type": "server", "server": {"id": a["server"]["id"]}})
            return 201, {"actions": [action(d, "apply_firewall")]}
        if kind == "volumes" and name == "attach":
            obj["server"] = b["server"]
            return 201, {"action": action(d, "attach_volume")}
        if kind == "volumes" and name == "resize":
            if b["size"] <= obj["size"]:
                return 422, {"error": {"code": "invalid_input", "message": "cannot shrink"}}
            obj["size"] = b["size"]
            return 201, {"action": action(d, "resize_volume")}
        if name == "change_protection":
            obj["protection"].update(b)
            return 201, {"action": action(d, "change_protection")}
        if kind == "servers" and name == "change_type":
            obj["server_type"] = {"name": b.get("server_type")}
            obj["RESCALED"] = True   # the tests assert this never happens
            return 201, {"action": action(d, "change_server_type")}
        if kind == "servers" and name == "enable_rescue":
            obj["rescue_enabled"] = True
            return 201, {"action": action(d, "enable_rescue"), "root_password": "fake-root-pw-should-not-print"}
        if kind == "servers" and name in ("disable_rescue", "reset", "reboot"):
            if name == "disable_rescue":
                obj["rescue_enabled"] = False
            return 201, {"action": action(d, name)}
        raise KeyError(f"action {kind}/{name}")


def main() -> None:
    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    PORTFILE.write_text(str(srv.server_address[1]))
    srv.serve_forever()


if __name__ == "__main__":
    main()
