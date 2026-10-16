#!/usr/bin/env python3
"""Render infra/server/host-firewall.nft (a template) into a loadable nftables file.

Used by infra/server/host-firewall.sh (render / apply) and infra/render-cloud-init.py, so the server's
first boot and a later re-apply produce the same ruleset.

Fills:
  __PD_CLOUDFLARE4__ / __PD_CLOUDFLARE6__   elements of the cloudflare4/cloudflare6 sets, from the list file
  __PD_ADMIN_SSH4__ / __PD_ADMIN_SSH6__     elements of admin_ssh4/admin_ssh6, from [network] admin_ssh_cidrs
  __PD_HTTPS_RULES__                        port 443 from the Cloudflare sets ([network] cloudflare_only = true,
                                            the default) or from anywhere (false). Never port 80.

Refuses an empty or invalid Cloudflare list (each entry goes through netutil.cloudflare_net), so a damaged
list can never produce a firewall that locks everyone out or opens 443 to the world by accident.

CLI:  fwrender.py render [--tenant PATH] [--ips PATH] [--template PATH]
Nothing here touches the network; the list file is read from disk.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import netutil  # noqa: E402
import tenant  # noqa: E402

DEFAULT_TEMPLATE = HERE.parent / "server" / "host-firewall.nft"
DEFAULT_IPS = HERE.parent / "server" / "cloudflare-ips.txt"


class RenderError(Exception):
    pass


def parse_cloudflare(text: str) -> tuple[list[str], list[str]]:
    v4: list[str] = []
    v6: list[str] = []
    for lineno, raw in enumerate(text.splitlines(), 1):
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        version = 6 if ":" in line else 4
        try:
            net = netutil.cloudflare_net(line, version)
        except ValueError as exc:
            raise RenderError(f"cloudflare list line {lineno}: {exc}") from exc
        (v6 if version == 6 else v4).append(net)
    if not v4 or not v6:
        raise RenderError("cloudflare list must hold at least one IPv4 and one IPv6 range "
                          f"(found {len(v4)} IPv4, {len(v6)} IPv6); refusing to build a firewall from it")
    return v4, v6


def _elements(items: list[str]) -> str:
    return f"\t\telements = {{ {', '.join(items)} }}" if items else ""


def render(template: str, cf_text: str, cloudflare_only: bool, admin_cidrs: list[str]) -> str:
    v4, v6 = parse_cloudflare(cf_text)
    a4: list[str] = []
    a6: list[str] = []
    for raw in admin_cidrs:
        try:
            cidr = netutil.admin_cidr(str(raw))
        except ValueError as exc:
            raise RenderError(f"[network] admin_ssh_cidrs: {exc}") from exc
        (a6 if ":" in cidr else a4).append(cidr)
    if cloudflare_only:
        https = ("\t\ttcp dport 443 ip saddr @cloudflare4 accept\n"
                 "\t\ttcp dport 443 ip6 saddr @cloudflare6 accept")
    else:
        https = "\t\ttcp dport 443 accept"
    repl = {
        "__PD_CLOUDFLARE4__": _elements(v4),
        "__PD_CLOUDFLARE6__": _elements(v6),
        "__PD_ADMIN_SSH4__": _elements(a4),
        "__PD_ADMIN_SSH6__": _elements(a6),
        "__PD_HTTPS_RULES__": https,
    }
    out = template
    for token, value in repl.items():
        if out.count(token) != 1:
            raise RenderError(f"template must contain {token} exactly once (found {out.count(token)})")
        out = out.replace(token, value)
    left = re.findall(r"__PD_[A-Z0-9_]+__", out)
    if left:
        raise RenderError(f"unfilled token left in the firewall template: {left[0]}")
    return out


def render_from_files(tenant_path: str | None, ips_path: str | None, template_path: str | None = None) -> str:
    data = tenant.load(tenant_path)
    cloudflare_only = bool(tenant.get(data, "network.cloudflare_only", True))
    admin = tenant.get(data, "network.admin_ssh_cidrs", [])
    if not isinstance(admin, list):
        raise RenderError("[network] admin_ssh_cidrs must be a list")
    tpl = Path(template_path) if template_path else DEFAULT_TEMPLATE
    ips = Path(ips_path) if ips_path else DEFAULT_IPS
    if not ips.is_file():
        raise RenderError(f"cloudflare list not found: {ips}")
    return render(tpl.read_text(encoding="utf-8"), ips.read_text(encoding="utf-8"), cloudflare_only, admin)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("render")
    r.add_argument("--tenant")
    r.add_argument("--ips")
    r.add_argument("--template")
    args = ap.parse_args(argv)
    try:
        sys.stdout.buffer.write(render_from_files(args.tenant, args.ips, args.template).encode("utf-8"))
    except (RenderError, tenant.TenantError) as exc:
        print(f"fwrender: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
