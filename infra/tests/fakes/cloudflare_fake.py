#!/usr/bin/env python3
"""A local fake of the few Cloudflare API calls infra/dns/cloudflare-dns.py makes. Test use only.

usage: cloudflare_fake.py STATE.json CALLS.log PORTFILE TOKEN

Serves http://127.0.0.1:<port>/client/v4 (the port is written to PORTFILE). Every request line and whether the
Authorization header carried TOKEN ("auth=OK"/"auth=BAD") are appended to CALLS.log; STATE.json holds
{"zone": {"id", "name"}, "records": [...]} and is rewritten after every change.
"""
from __future__ import annotations

import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

STATE_PATH, CALLS_PATH, PORT_PATH, TOKEN = sys.argv[1:5]


def load() -> dict:
    with open(STATE_PATH, encoding="utf-8") as fh:
        return json.load(fh)


def save(d: dict) -> None:
    with open(STATE_PATH, "w", encoding="utf-8") as fh:
        json.dump(d, fh)


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def log_message(self, *_a) -> None:  # noqa: D401
        pass

    def _reply(self, code: int, result, ok: bool = True) -> None:
        body = json.dumps({"success": ok, "errors": [] if ok else [{"code": code, "message": "fake error"}], "result": result}).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _handle(self, method: str) -> None:
        auth = "auth=OK" if self.headers.get("Authorization") == f"Bearer {TOKEN}" else "auth=BAD"
        with open(CALLS_PATH, "a", encoding="utf-8") as fh:
            fh.write(f"{method} {self.path} {auth}\n")
        if auth != "auth=OK":
            return self._reply(403, None, ok=False)
        u = urlparse(self.path)
        q = parse_qs(u.query)
        parts = [p for p in u.path.split("/") if p]  # client v4 zones ...
        d = load()
        body = {}
        n = int(self.headers.get("Content-Length") or 0)
        if n:
            body = json.loads(self.rfile.read(n))
        if parts[:3] == ["client", "v4", "zones"] and len(parts) == 3 and method == "GET":
            z = d["zone"]
            return self._reply(200, [z] if q.get("name", [""])[0] == z["name"] else [])
        if len(parts) >= 5 and parts[4] == "dns_records":
            recs = d["records"]
            if method == "GET":
                t, name = q.get("type", [""])[0], q.get("name", [""])[0]
                return self._reply(200, [r for r in recs if r["type"] == t and r["name"] == name])
            if method == "POST":
                rec = dict(body)
                rec["id"] = f"rec{len(recs) + 1}"
                recs.append(rec)
                save(d)
                return self._reply(200, rec)
            if method == "PATCH" and len(parts) == 6:
                for r in recs:
                    if r["id"] == parts[5]:
                        r.update(body)
                        save(d)
                        return self._reply(200, r)
        return self._reply(404, None, ok=False)

    def do_GET(self) -> None:  # noqa: N802
        self._handle("GET")

    def do_POST(self) -> None:  # noqa: N802
        self._handle("POST")

    def do_PATCH(self) -> None:  # noqa: N802
        self._handle("PATCH")


def main() -> None:
    srv = HTTPServer(("127.0.0.1", 0), H)
    with open(PORT_PATH, "w", encoding="utf-8") as fh:
        fh.write(str(srv.server_address[1]))
    srv.serve_forever()


if __name__ == "__main__":
    main()
