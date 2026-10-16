#!/usr/bin/env python3
"""Cloudflare DNS for PD (ported from Drive PR #3's infra/dns/cloudflare-dns.py).

Implements: docs/plans/01-infrastructure.md (DNS: the name is proxied through Cloudflare; the origin only
accepts 443 from Cloudflare, host firewall) and Drive D-146/D-149 (server addresses come from the provider adapter).

Subcommands
  apply   idempotent upsert of the records for tenant.domain in zone tenant.dns_zone:
            A      <domain>  <server IPv4>   proxied per [dns] proxied   TTL per [dns] ttl (1 = automatic)
            AAAA   <domain>  <server IPv6>   same
          Existing correct records are left alone; a missing record is created. Changing an EXISTING record
          (wrong content, TTL or proxy flag: e.g. moving the name to another server) needs --confirm; without it
          apply prints what would change and exits 1 before any write. Nothing is ever deleted. There are no CAA records and no ACME: the origin uses a Cloudflare origin
          certificate, so nothing here talks to a certificate authority.
  check   compares the A and AAAA records the Cloudflare API holds with the server's addresses. It does NOT use
          DNS resolution: a proxied name always resolves to Cloudflare, which proves nothing about the origin.

Server addresses: --ipv4/--ipv6, or --from-provider (asks the [infra] provider adapter,
infra/server-addresses.sh, for the server named tenant.hostname; needs that provider's key in the secrets
file), or placeholders under --dry-run.

Common flags: --dry-run (no network, no changes: prints the intended records / checks),
              --tenant PATH, --secrets PATH.
Secret: CLOUDFLARE_DNS_TOKEN (secrets file). It is sent only in the Authorization header, never in argv and
never printed. The API base is https://api.cloudflare.com/client/v4; $PD_CLOUDFLARE_API may name a local test
fake (http://127.0.0.1:<port>/client/v4 or http://localhost:...) and nothing else, so the token cannot be sent
to another host.

Exit status: 0 ok / PASS, 1 failure / FAIL, 2 usage or environment error.
"""
from __future__ import annotations

import argparse
import ipaddress
import json
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
import tenant  # noqa: E402

CF_API_DEFAULT = "https://api.cloudflare.com/client/v4"
LOCAL_PREFIXES = ("http://127.0.0.1:", "http://localhost:")
TTL_UNPROXIED = 300


class Fail(Exception):
    pass


def api_base() -> str:
    """The API base URL, refused unless it is the real Cloudflare API or a local test fake."""
    base = os.environ.get("PD_CLOUDFLARE_API", CF_API_DEFAULT).rstrip("/")
    if base != CF_API_DEFAULT and not base.startswith(LOCAL_PREFIXES):
        raise Fail(f"PD_CLOUDFLARE_API must be {CF_API_DEFAULT} (got {base!r}); only a 127.0.0.1 or localhost URL is "
                   "allowed for a test fake, so the token cannot be sent anywhere else")
    return base


# ------------------------------------------------------------------ Cloudflare API

class CF:
    def __init__(self, token: str):
        self._token = token
        self._base = api_base()

    def call(self, method: str, path: str, body: dict | None = None, query: str = "") -> dict:
        url = f"{self._base}{path}" + (f"?{query}" if query else "")
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Authorization", f"Bearer {self._token}")
        req.add_header("User-Agent", "pd-infra/1.0")
        req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                payload = json.load(resp)
        except urllib.error.HTTPError as exc:
            try:
                payload = json.load(exc)
            except Exception:  # noqa: BLE001
                raise Fail(f"Cloudflare API {method} {path}: HTTP {exc.code}") from None
        except urllib.error.URLError as exc:
            raise Fail(f"Cloudflare API unreachable: {exc.reason}") from None
        if not payload.get("success"):
            errs = "; ".join(f"{e.get('code')}: {e.get('message')}" for e in payload.get("errors", []))
            raise Fail(f"Cloudflare API {method} {path} failed: {errs or 'unknown error'}")
        return payload

    def zone_id(self, zone: str) -> str:
        res = self.call("GET", "/zones", query=f"name={zone}")["result"]
        if not res:
            raise Fail(f"zone {zone} not found (or the token cannot see it)")
        return res[0]["id"]

    def records(self, zone_id: str, rtype: str, name: str) -> list[dict]:
        return self.call("GET", f"/zones/{zone_id}/dns_records", query=f"type={rtype}&name={name}&per_page=100")["result"]


# ------------------------------------------------------------------ desired state

def dns_settings(data: dict) -> tuple[bool, int]:
    proxied = bool(tenant.get(data, "dns.proxied", True))
    ttl = int(tenant.get(data, "dns.ttl", 1 if proxied else TTL_UNPROXIED))
    if proxied and ttl != 1:
        raise Fail("[dns] proxied = true needs ttl = 1 (Cloudflare 'automatic')")
    return proxied, ttl


def desired_records(domain: str, ipv4: str, ipv6: str, proxied: bool, ttl: int) -> list[dict]:
    return [
        {"type": "A", "name": domain, "content": ipv4, "ttl": ttl, "proxied": proxied},
        {"type": "AAAA", "name": domain, "content": ipv6, "ttl": ttl, "proxied": proxied},
    ]


def describe(rec: dict) -> str:
    mode = "proxied" if rec.get("proxied") else "DNS-only"
    return f'{rec["type"]:<5} {rec["name"]}  {rec["content"]}  {mode}  TTL {rec["ttl"]} (proxied: {str(bool(rec.get("proxied"))).lower()})'


def global_ip(text: str, version: int) -> str:
    try:
        ip = ipaddress.ip_address(text)
    except ValueError as exc:
        raise Fail(f"not an IP address: {text!r}") from exc
    if ip.version != version or not ip.is_global:
        raise Fail(f"{text} is not a public IPv{version} address")
    return str(ip)


def addresses_from_provider(data: dict, tenant_file: str | None, secrets_file: str | None) -> tuple[str, str]:
    """Any adapter: run infra/server-addresses.sh (the provider dispatcher) and parse '<ipv4> <ipv6>'."""
    bash = os.environ.get("PD_BASH") or shutil.which("bash")
    if not bash:
        raise Fail("bash not found (needed to run infra/server-addresses.sh)")
    cmd = [bash, str(Path(__file__).resolve().parents[1] / "server-addresses.sh")]
    if tenant_file:
        cmd += ["--tenant", tenant_file]
    if secrets_file:
        cmd += ["--secrets", secrets_file]
    res = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if res.returncode != 0:
        raise Fail(f"infra/server-addresses.sh failed: {res.stderr.strip()[-300:]}")
    parts = (res.stdout.strip().splitlines() or [""])[-1].split()
    v4, v6 = (parts + ["-", "-"])[:2]
    if v4 == "-":
        raise Fail(f"server {tenant.get(data, 'tenant.hostname')} has no IPv4 address from the provider; pass --ipv4 explicitly")
    return v4, v6


def resolve_addresses(args, data: dict) -> tuple[str, str]:
    """(ipv4, ipv6) for apply/check; '' for a family that is not known (an ssh server may have no IPv6)."""
    hostname = str(tenant.get(data, "tenant.hostname"))
    ipv4, ipv6 = args.ipv4 or "", args.ipv6 or ""
    if args.from_provider:
        provider = str(tenant.get(data, "infra.provider"))
        if args.dry_run:
            print(f"[dry-run] would read addresses of server {hostname} from the '{provider}' adapter (infra/server-addresses.sh)")
        else:
            v4, v6 = addresses_from_provider(data, args.tenant_path, args.secrets_path)
            ipv4, ipv6 = ipv4 or v4, ipv6 or (v6 if v6 != "-" else "")
    if args.dry_run:
        ipv4 = global_ip(ipv4, 4) if ipv4 else "<server-ipv4>"
        ipv6 = global_ip(ipv6, 6) if ipv6 else "<server-ipv6>"
    else:
        if not ipv4:
            raise Fail("server IPv4 needed: pass --ipv4, or --from-provider")
        ipv4 = global_ip(ipv4, 4)
        ipv6 = global_ip(ipv6, 6) if ipv6 else ""
    return ipv4, ipv6


# ------------------------------------------------------------------ apply

def cmd_apply(args, data: dict, secrets: dict[str, str]) -> int:
    domain = str(tenant.get(data, "tenant.domain"))
    zone = str(tenant.get(data, "tenant.dns_zone"))
    if not (domain == zone or domain.endswith("." + zone)):
        raise Fail(f"tenant.domain {domain} is not inside tenant.dns_zone {zone}")
    proxied, ttl = dns_settings(data)
    ipv4, ipv6 = resolve_addresses(args, data)
    want = desired_records(domain, ipv4, ipv6, proxied, ttl)
    if not ipv6:
        want = want[:1]
        print("note: no IPv6 address known; only the A record is managed")
    return apply_records(args, secrets, zone, domain, want)


def apply_records(args, secrets: dict[str, str], zone: str, host: str, want: list[dict]) -> int:
    print(f"zone: {zone}   host: {host}")
    print("intended records:")
    for rec in want:
        print("  " + describe(rec))
    if args.dry_run:
        api_base()  # a bad PD_CLOUDFLARE_API is refused even in a dry run
        print("[dry-run] no API calls made. A real run looks each record up first and only creates/updates what differs.")
        return 0

    token = secrets.get("CLOUDFLARE_DNS_TOKEN") or os.environ.get("CLOUDFLARE_DNS_TOKEN")
    if not token:
        raise Fail("CLOUDFLARE_DNS_TOKEN is not set in the secrets file")
    cf = CF(token)
    zid = cf.zone_id(zone)

    # Look every record up first, then write: a refused change leaves the zone exactly as it was.
    plan: list[tuple[str, dict, dict | None]] = []
    for rec in want:
        name, rtype = rec["name"], rec["type"]
        existing = cf.records(zid, rtype, name)
        if len(existing) > 1:
            raise Fail(f"{len(existing)} {rtype} records already exist for {name}; resolve by hand")
        if not existing:
            plan.append(("create", rec, None))
            continue
        cur = existing[0]
        same = cur["content"] == rec["content"] and cur["ttl"] == rec["ttl"] and bool(cur.get("proxied")) is bool(rec["proxied"])
        plan.append(("ok" if same else "update", rec, cur))

    updates = [(rec, cur) for action, rec, cur in plan if action == "update"]
    if updates and not getattr(args, "confirm", False):
        for rec, cur in updates:
            print(f"would update: {describe(rec)}   (now {cur['content']}, ttl {cur['ttl']}, proxied={cur.get('proxied')})")
        raise Fail(f"{len(updates)} existing record(s) would change (this moves {host} for every user): "
                   "nothing was written. Re-run with --confirm")

    for action, rec, cur in plan:
        if action == "create":
            cf.call("POST", f"/zones/{zid}/dns_records", rec)
            print(f"created : {describe(rec)}")
        elif action == "ok":
            print(f"ok      : {describe(rec)}")
        else:
            assert cur is not None
            cf.call("PATCH", f"/zones/{zid}/dns_records/{cur['id']}",
                    {"content": rec["content"], "ttl": rec["ttl"], "proxied": rec["proxied"]})
            print(f"updated : {describe(rec)}   (was {cur['content']}, ttl {cur['ttl']}, proxied={cur.get('proxied')})")
    print("done.")
    return 0


# ------------------------------------------------------------------ check

def cmd_check(args, data: dict, secrets: dict[str, str]) -> int:
    domain = str(tenant.get(data, "tenant.domain"))
    zone = str(tenant.get(data, "tenant.dns_zone"))
    proxied, ttl = dns_settings(data)
    print(f"check: the Cloudflare records of {domain} must point at the server (read through the API, not DNS resolution)")
    ipv4, ipv6 = resolve_addresses(args, data)
    if args.dry_run:
        api_base()
        print(f"[dry-run] would read the A and AAAA records of {domain} from the Cloudflare API and compare with "
              f"{ipv4} / {ipv6}; proxied must be {str(proxied).lower()}")
        return 0
    token = secrets.get("CLOUDFLARE_DNS_TOKEN") or os.environ.get("CLOUDFLARE_DNS_TOKEN")
    if not token:
        raise Fail("CLOUDFLARE_DNS_TOKEN is not set in the secrets file")
    cf = CF(token)
    zid = cf.zone_id(zone)
    ok = True
    for rtype, expect in (("A", ipv4), ("AAAA", ipv6)):
        if not expect:
            continue
        recs = cf.records(zid, rtype, domain)
        if len(recs) != 1:
            print(f"FAIL {rtype}: {len(recs)} records for {domain}, expected 1")
            ok = False
            continue
        cur = recs[0]
        if cur["content"] != expect:
            print(f"FAIL {rtype}: record holds {cur['content']}, server is {expect}")
            ok = False
        elif bool(cur.get("proxied")) is not proxied:
            print(f"FAIL {rtype}: proxied={cur.get('proxied')}, [dns] proxied = {str(proxied).lower()}")
            ok = False
        else:
            print(f"PASS {rtype}: {cur['content']} (proxied={str(bool(cur.get('proxied'))).lower()})")
    print("CHECK: " + ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


# ------------------------------------------------------------------ main

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--tenant")
    ap.add_argument("--secrets")
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("apply", help="upsert the A/AAAA records")
    a.add_argument("--confirm", action="store_true", help="allow changing an existing record (creating one needs no --confirm)")
    c = sub.add_parser("check", help="compare the API records with the server addresses")
    for p in (a, c):
        p.add_argument("--ipv4", "--ip4", dest="ipv4")
        p.add_argument("--ipv6", "--ip6", dest="ipv6")
        p.add_argument("--from-provider", action="store_true", help="read the server addresses from the [infra] provider adapter")
        # allow the common flags after the subcommand too
        p.add_argument("--dry-run", action="store_true", dest="dry_run_sub")
        p.add_argument("--tenant", dest="tenant_sub")
        p.add_argument("--secrets", dest="secrets_sub")
    args = ap.parse_args()
    args.dry_run = args.dry_run or args.dry_run_sub
    args.tenant = args.tenant or args.tenant_sub
    args.secrets = args.secrets or args.secrets_sub

    try:
        data = tenant.load(args.tenant)
        secrets: dict[str, str] = {}
        sp = tenant.secrets_path(args.secrets)
        args.tenant_path = str(tenant.tenant_path() if not args.tenant else args.tenant)
        args.secrets_path = str(sp) if sp is not None and sp.is_file() else None
        if sp is not None and sp.is_file():
            secrets = tenant.load_env_file(sp)
        elif not args.dry_run and not os.environ.get("CLOUDFLARE_DNS_TOKEN"):
            raise Fail("secrets file not found. Set PD_SECRETS or pass --secrets PATH.")
        if args.cmd == "apply":
            return cmd_apply(args, data, secrets)
        return cmd_check(args, data, secrets)
    except (Fail, tenant.TenantError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
