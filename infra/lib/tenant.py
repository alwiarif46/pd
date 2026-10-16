#!/usr/bin/env python3
"""Tenant config + secrets-file helpers shared by the infra scripts.

Implements: docs/plans/01-infrastructure.md (all sections that read config/tenant.toml),
docs/10 §2 (operator-specific values come from config/tenant.toml only).

Library use (Python scripts):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
    import tenant
    t = tenant.load()                      # honours $PD_TENANT
    domain = tenant.get(t, "tenant.domain")
    tenant.load_env_file(path)             # secrets: returns dict, never prints values

CLI use (this is what lib/tenant.sh calls):
    python3 tenant.py get <section.key> [--tenant PATH] [--default VALUE]

Fails loudly (exit 1, message on stderr) when a key is missing and no default is given.
Secret values are never printed by anything in this module.
"""
from __future__ import annotations

import argparse
import os
import re
import sys
import tomllib
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_TENANT = REPO_ROOT / "config" / "tenant.toml"

# Keys the secrets file may define. Anything else in the file is ignored (not exported).
SECRET_KEYS = (
    "OS_APPLICATION_CREDENTIAL_SECRET",
    "OS_PASSWORD",
    "CLOUDFLARE_DNS_TOKEN",
    "B2_KEY_ID",
    "B2_APP_KEY",
    "HCLOUD_TOKEN",       # Hetzner adapter (infra/providers/hetzner, D-146)
)
# Non-secret settings that live in the same file.
PLAIN_KEYS = ("OS_APPLICATION_CREDENTIAL_ID", "OS_USERNAME", "OS_PROJECT_ID", "SSH_PUBKEY_PATH", "ADMIN_IP")
ALLOWED_ENV_KEYS = SECRET_KEYS + PLAIN_KEYS

_ENV_LINE = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$")


class TenantError(Exception):
    pass


def tenant_path() -> Path:
    raw = os.environ.get("PD_TENANT")
    return Path(raw) if raw else DEFAULT_TENANT


def load(path: str | os.PathLike[str] | None = None) -> dict[str, Any]:
    p = Path(path) if path else tenant_path()
    try:
        with open(p, "rb") as fh:
            return tomllib.load(fh)
    except FileNotFoundError as exc:
        raise TenantError(f"tenant file not found: {p}") from exc
    except tomllib.TOMLDecodeError as exc:
        raise TenantError(f"tenant file {p} is not valid TOML: {exc}") from exc


_MISSING = object()


def get(data: dict[str, Any], dotted: str, default: Any = _MISSING) -> Any:
    node: Any = data
    for part in dotted.split("."):
        if not isinstance(node, dict) or part not in node:
            if default is _MISSING:
                raise TenantError(f"missing tenant key: {dotted}")
            return default
        node = node[part]
    return node


def fmt(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (list, tuple)):
        return "\n".join(fmt(v) for v in value)
    return str(value)


def parse_env_text(text: str) -> dict[str, str]:
    """Parse KEY=VALUE lines without executing anything. Only ALLOWED_ENV_KEYS are returned."""
    out: dict[str, str] = {}
    for line in text.splitlines():
        line = line.rstrip("\r")
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        m = _ENV_LINE.match(line)
        if not m:
            continue
        key, val = m.group(1), m.group(2)
        if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
            val = val[1:-1]
        elif " #" in val:  # trailing comment on an unquoted value
            val = val.split(" #", 1)[0].rstrip()
        if key in ALLOWED_ENV_KEYS:
            out[key] = val
    return out


def load_env_file(path: str | os.PathLike[str]) -> dict[str, str]:
    p = Path(path)
    if not p.is_file():
        raise TenantError(f"secrets file not found: {p}")
    return parse_env_text(p.read_text(encoding="utf-8-sig"))


def secrets_path(explicit: str | None = None) -> Path | None:
    raw = explicit or os.environ.get("PD_SECRETS")
    if raw:
        return Path(raw)
    try:
        guess = get(load(), "tenant.secrets_file", "")
    except TenantError:
        guess = ""
    if guess and Path(guess).is_file():
        return Path(guess)
    return None


def mask(text: str, values: list[str]) -> str:
    for v in values:
        if v:
            text = text.replace(v, "***")
    return text


def _main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="Read a value from config/tenant.toml")
    sub = ap.add_subparsers(dest="cmd", required=True)
    g = sub.add_parser("get", help="print one value")
    g.add_argument("key", help="section.key, e.g. tenant.domain")
    g.add_argument("--tenant", help="tenant.toml path (default: $PD_TENANT or config/tenant.toml)")
    g.add_argument("--default", help="value to print if the key is missing")
    args = ap.parse_args(argv)
    try:
        data = load(args.tenant)
        if args.default is not None:
            print(fmt(get(data, args.key, args.default)))
        else:
            print(fmt(get(data, args.key)))
    except TenantError as exc:
        print(f"tenant: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
