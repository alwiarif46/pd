#!/usr/bin/env python3
"""Provider-neutral address helpers (no network except DNS resolution, no secrets).

Implements: docs/plans/01-infrastructure.md section 4 (admin SSH is a single public address; the admin
network is 100.64.0.0/10 / fd7a:115c:a1e0::/48) for every provider adapter and the host firewall
(Drive D-146: moved here from the OVH-only ostool.py so non-OVH hosts need no OVH code).

Subcommands:
  cidr <ip>               validate an admin IP and print it as /32 or /128 (rejects non-public)
  tailnet-addr <host>     resolve host (or accept an IP) and print the first address inside
                          100.64.0.0/10 or fd7a:115c:a1e0::/48; exit 1 (message on stderr) if none
"""
from __future__ import annotations

import ipaddress
import socket
import sys

TAILNET_NETS = [ipaddress.ip_network("100.64.0.0/10"), ipaddress.ip_network("fd7a:115c:a1e0::/48")]


def cmd_tailnet_addr(host: str) -> int:
    try:
        addrs = sorted({str(a[4][0]) for a in socket.getaddrinfo(host, 22, type=socket.SOCK_STREAM)})
    except socket.gaierror as exc:
        print(f"cannot resolve {host!r}: {exc}", file=sys.stderr)
        return 1
    for a in addrs:
        ip = ipaddress.ip_address(a.split("%", 1)[0])
        if any(ip in n for n in TAILNET_NETS if n.version == ip.version):
            print(a)
            return 0
    print(f"{host!r} resolves to {', '.join(addrs) or 'nothing'}: not inside 100.64.0.0/10 or "
          "fd7a:115c:a1e0::/48 (that would test the public path, not the admin network)", file=sys.stderr)
    return 1


def admin_cidr(raw: str) -> str:
    """Return the single public address as /32 or /128; raise ValueError with the reason otherwise."""
    text = raw.strip()
    if "/" in text:
        net = ipaddress.ip_network(text, strict=True)
        if net.num_addresses != 1:
            raise ValueError(f"refusing {text}: admin SSH must be a single address (/32 or /128)")
        addr = net.network_address
    else:
        addr = ipaddress.ip_address(text)
    if not addr.is_global:
        raise ValueError(f"refusing {addr}: not a public address (private/loopback/link-local/reserved)")
    return f"{addr}/{32 if addr.version == 4 else 128}"


def cmd_cidr(raw: str) -> int:
    try:
        print(admin_cidr(raw))
    except ValueError as exc:
        msg = str(exc)
        print(msg if msg.startswith("refusing") else f"not a valid IP address: {raw.strip()!r} ({exc})", file=sys.stderr)
        return 1
    return 0


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    if argv[0] == "cidr":
        return cmd_cidr(argv[1])
    if argv[0] == "tailnet-addr":
        return cmd_tailnet_addr(argv[1])
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
