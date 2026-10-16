#!/usr/bin/env python3
"""Render infra/cloud-init.yaml into a deployable user-data file.

Implements: docs/plans/01-infrastructure.md ("Do not paste a real password hash or SSH key into the repo
copy of this file"; Drive PR #3 layout).

Fills in:
  __PD_HOSTNAME__            <- config/tenant.toml  tenant.hostname
  ssh-ed25519 AAAA... amaan      <- the public key file named by SSH_PUBKEY_PATH (secrets file)
  $6$REPLACE_WITH_HASH           <- sha512-crypt hash from env PDADMIN_HASH, or generated from a
                                    password you type (openssl passwd -6 / mkpasswd -m sha-512)
  pdadmin                        <- tenant.toml server.admin_user (only if it differs)
  __PD_HOST_FIREWALL_NFT__   <- infra/server/host-firewall.nft filled by infra/lib/fwrender.py (Cloudflare ranges,
                                    [network] values; Drive D-135)
  __PD_CLOUDFLARE_IPS__      <- infra/server/cloudflare-ips.txt (the server's /etc/pd/cloudflare-ips.txt)
  __PD_HOST_FIREWALL_UNIT__  <- infra/server/pd-host-firewall.service
  __PD_BOOTSTRAP_SSH__       <- `nft add element` admitting ADMIN_IP (secrets file or env) to SSH
                                    for [infra] bootstrap_ssh_hours (the first-boot window)

Writes ONLY outside the repository (default: <tempdir>/pd-cloud-init/user-data.yaml) and
refuses any --out inside the repo. The output holds a password hash: treat it as sensitive and
delete it after use. Nothing secret is printed.

Usage:
  render-cloud-init.py [--dry-run] [--tenant PATH] [--secrets PATH] [--out PATH]
                       [--pubkey-file PATH] [--hash-env NAME]

  --dry-run   render in memory with dummy hash/key placeholders, validate, write nothing
  --skip-yaml-check
              only with --dry-run: skip the PyYAML syntax check (a real run requires PyYAML:
              pip install --user pyyaml)

Password hash under Git Bash (mintty): a native python.exe often sees a pipe, not a terminal, so
the interactive prompt is refused. Make the hash in the shell instead, then run this script:
    read -rs P; export PDADMIN_HASH=$(printf '%s\n' "$P" | openssl passwd -6 -salt "rounds=500000\\$$(openssl rand -hex 8)" -stdin); unset P
(or use a PowerShell/cmd console, or `winpty python ...`, where the prompt works).
Environment: PDADMIN_HASH (ready-made $6$ hash), PD_TENANT, PD_SECRETS, SSH_PUBKEY_PATH, ADMIN_IP.
"""
from __future__ import annotations

import argparse
import getpass
import ipaddress
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))
import fwrender  # noqa: E402
import tenant  # noqa: E402

TEMPLATE = Path(__file__).resolve().parent / "cloud-init.yaml"
CF_IPS = Path(__file__).resolve().parent / "server" / "cloudflare-ips.txt"
FW_UNIT = Path(__file__).resolve().parent / "server" / "pd-host-firewall.service"
FW_NFT_TOKEN = "      __PD_HOST_FIREWALL_NFT__"
FW_UNIT_TOKEN = "      __PD_HOST_FIREWALL_UNIT__"
CF_IPS_TOKEN = "      __PD_CLOUDFLARE_IPS__"
BOOTSTRAP_TOKEN = "__PD_BOOTSTRAP_SSH__"
DRY_ADMIN_IP = "198.51.100.7"   # TEST-NET-2, only for --dry-run output
REPO_ROOT = tenant.REPO_ROOT

HOSTNAME_TOKEN = "__PD_HOSTNAME__"
HASH_PLACEHOLDER = "$6$REPLACE_WITH_HASH"
KEY_PLACEHOLDER = "ssh-ed25519 AAAA... amaan"
TEMPLATE_ADMIN_USER = "pdadmin"

HASH_RE = re.compile(r"^\$6\$(rounds=\d+\$)?[./0-9A-Za-z]{1,16}\$[./0-9A-Za-z]{86}$")
HOSTNAME_RE = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")
USER_RE = re.compile(r"^[a-z_][a-z0-9_-]{0,31}$")
PUBKEY_RE = re.compile(r"^ssh-ed25519 [A-Za-z0-9+/=]{20,} ?\S*$")

DRY_HASH = "$6$DRYRUN$" + "x" * 86
# Short on purpose (< 40 base64 chars after AAAA) so the secret scan never mistakes it for a real key.
DRY_KEY = "ssh-ed25519 AAAADRYRUNDRYRUNDRYRUNDRYRUN dry-run"


def die(msg: str) -> "None":
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def inside_repo(path: Path) -> bool:
    try:
        path.resolve().relative_to(REPO_ROOT.resolve())
        return True
    except ValueError:
        return False


def read_pubkey(path_str: str) -> str:
    p = Path(path_str).expanduser()
    if not p.is_file():
        die(f"SSH public key file not found: {p}")
    text = p.read_text(encoding="utf-8").strip()
    if "PRIVATE KEY" in text:
        die(f"{p} looks like a PRIVATE key. Point SSH_PUBKEY_PATH at the .pub file.")
    lines = [ln for ln in text.splitlines() if ln.strip()]
    if len(lines) != 1 or not PUBKEY_RE.match(lines[0].strip()):
        die(f"{p} is not a single ssh-ed25519 public key line (plan 01 uses key amaan-ed25519).")
    return lines[0].strip()


HASH_ROUNDS = 500000  # audit MEDIUM-2: the hash travels in user-data (metadata service); slow it down


def make_hash(password: str) -> str:
    """sha512-crypt with rounds=500000 via openssl (rounds in the salt) or mkpasswd -R. The password goes
    over stdin, never argv."""
    import secrets
    salt = "".join(secrets.choice("./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz") for _ in range(16))
    if shutil.which("openssl"):
        cmd = ["openssl", "passwd", "-6", "-salt", f"rounds={HASH_ROUNDS}${salt}", "-stdin"]
    elif shutil.which("mkpasswd"):
        cmd = ["mkpasswd", "-m", "sha-512", "-R", str(HASH_ROUNDS), "-s"]
    else:
        die("need `openssl` or `mkpasswd` to hash the password, or set PDADMIN_HASH to a ready $6$ hash.")
    res = subprocess.run(cmd, input=password + "\n", capture_output=True, text=True, check=False)
    out = res.stdout.strip()
    if res.returncode != 0 or not HASH_RE.match(out) or f"rounds={HASH_ROUNDS}$" not in out:
        die("hashing failed (could not produce a $6$rounds=500000$ sha512-crypt hash)")
    return out


def stdin_is_console() -> bool:
    """True only for a real terminal. On Windows os.isatty() is also True for NUL, so ask the console API."""
    try:
        if not sys.stdin.isatty():
            return False
        if os.name == "nt":
            import ctypes
            import msvcrt

            handle = msvcrt.get_osfhandle(sys.stdin.fileno())
            mode = ctypes.c_uint32()
            return bool(ctypes.windll.kernel32.GetConsoleMode(handle, ctypes.byref(mode)))
        return True
    except Exception:
        return False


def obtain_hash(env_name: str) -> str:
    supplied = os.environ.get(env_name, "").strip()
    if supplied:
        if not HASH_RE.match(supplied):
            die(f"${env_name} is not a valid $6$ sha512-crypt hash")
        if "$rounds=" not in supplied:
            print(f"WARNING: ${env_name} has the default 5000 rounds; the hash is readable through the metadata "
                  f"service, prefer: openssl passwd -6 -salt 'rounds={HASH_ROUNDS}$<16 salt chars>' -stdin", file=sys.stderr)
        return supplied
    if not stdin_is_console():
        die(
            f"no ${env_name} and stdin is not a terminal (typical under Git Bash/mintty). In the shell run:\n"
            "  read -rs P; export PDADMIN_HASH=$(printf '%s\\n' \"$P\" | openssl passwd -6 -salt \"rounds=500000\\$$(openssl rand -hex 8)\" -stdin); unset P\n"
            "then re-run this script (or run it from a PowerShell console / `winpty`)."
        )
    print("Choose the pdadmin sudo/console password (store it in the password manager).", file=sys.stderr)
    pw1 = getpass.getpass("pdadmin password: ")
    pw2 = getpass.getpass("repeat: ")
    if pw1 != pw2:
        die("passwords differ")
    if len(pw1) < 14:
        die("use at least 14 characters (this is the break-glass console password)")
    return make_hash(pw1)


def indented(text: str) -> str:
    """Text as a YAML block-scalar body (6 spaces, tabs expanded)."""
    lines = text.expandtabs(4).splitlines()
    return "\n".join(("      " + ln) if ln.strip() else "" for ln in lines)


def bootstrap_line(admin_ip: str, hours: int, dry: bool) -> str:
    try:
        ip = ipaddress.ip_address(admin_ip.strip().split("/", 1)[0])
    except ValueError:
        die(f"ADMIN_IP {admin_ip!r} is not an IP address")
    if not dry and not ip.is_global:
        die(f"ADMIN_IP {ip} is not a public address")
    if not 1 <= hours <= 24:
        die("[infra] bootstrap_ssh_hours must be 1-24")
    set_name = "bootstrap_ssh4" if ip.version == 4 else "bootstrap_ssh6"
    return f'[nft, add, element, inet, pd_fw, {set_name}, "{{ {ip} timeout {hours}h }}"]'


def render(hostname: str, admin_user: str, pubkey: str, pw_hash: str, bootstrap: str, fw_nft: str) -> str:
    text = TEMPLATE.read_text(encoding="utf-8")
    for token in (HOSTNAME_TOKEN, HASH_PLACEHOLDER, KEY_PLACEHOLDER, FW_NFT_TOKEN, FW_UNIT_TOKEN, CF_IPS_TOKEN, BOOTSTRAP_TOKEN):
        if text.count(token) != 1:
            die(f"template {TEMPLATE} must contain {token!r} exactly once (found {text.count(token)})")
    if not HOSTNAME_RE.match(hostname):
        die(f"tenant.hostname {hostname!r} is not a valid hostname")
    if not USER_RE.match(admin_user):
        die(f"server.admin_user {admin_user!r} is not a valid user name")
    # str.replace, never regex/format: the hash contains '$'.
    text = text.replace(HOSTNAME_TOKEN, hostname)
    text = text.replace(HASH_PLACEHOLDER, pw_hash)
    text = text.replace(KEY_PLACEHOLDER, pubkey)
    text = text.replace(FW_NFT_TOKEN, indented(fw_nft))
    text = text.replace(FW_UNIT_TOKEN, indented(FW_UNIT.read_text(encoding="utf-8")))
    text = text.replace(CF_IPS_TOKEN, indented(CF_IPS.read_text(encoding="utf-8")))
    text = text.replace(BOOTSTRAP_TOKEN, bootstrap)
    if admin_user != TEMPLATE_ADMIN_USER:
        text = re.sub(rf"\b{TEMPLATE_ADMIN_USER}\b", admin_user, text)
    for leftover in (HOSTNAME_TOKEN, "REPLACE_WITH_HASH", "AAAA..."):
        if leftover in text:
            die(f"unfilled placeholder left in output: {leftover}")
    tokens = re.findall(r"__PD_[A-Z0-9_]+__", text)
    if tokens:
        die(f"unfilled placeholder left in output: {tokens[0]}")
    return text


def validate_yaml(text: str, skip: bool = False) -> str:
    """Parse with PyYAML and sanity-check the structure. Mandatory unless skip (dry-run only)."""
    try:
        import yaml  # type: ignore
    except ImportError:
        if skip:
            return "SKIPPED (--skip-yaml-check, PyYAML not installed)"
        die("PyYAML is required to validate the rendered cloud-config: pip install --user pyyaml "
            "(--skip-yaml-check is allowed only with --dry-run)")
    if skip:
        return "SKIPPED (--skip-yaml-check)"
    first = text.splitlines()[0] if text else ""
    if first.strip() != "#cloud-config":
        die("first line must be #cloud-config")
    doc = yaml.safe_load(text)
    for key in ("hostname", "users", "packages", "write_files", "runcmd", "disable_root", "ssh_pwauth"):
        if key not in doc:
            die(f"rendered cloud-config is missing '{key}'")
    paths = {f.get("path"): f.get("content", "") for f in doc["write_files"]}
    if "table inet pd_fw" not in paths.get("/etc/pd/host-firewall.nft", ""):
        die("rendered cloud-config lacks the host firewall ruleset")
    fw = paths.get("/etc/pd/host-firewall.nft", "")
    if "@cloudflare4" not in fw or "dport 80" in fw:
        die("rendered host firewall must carry the Cloudflare sets and no port 80 rule")
    if "/etc/pd/cloudflare-ips.txt" not in paths:
        die("rendered cloud-config lacks /etc/pd/cloudflare-ips.txt")
    if not any(isinstance(c, list) and c[:3] == ["nft", "add", "element"] for c in doc["runcmd"]):
        die("rendered cloud-config lacks the bootstrap SSH element")
    user = doc["users"][0]
    if not user.get("ssh_authorized_keys") or not user.get("hashed_passwd"):
        die("rendered user lacks ssh_authorized_keys or hashed_passwd")
    return "YAML parsed OK (PyYAML)"


def main() -> int:
    ap = argparse.ArgumentParser(description="Render infra/cloud-init.yaml (placeholders -> deployable user-data)")
    ap.add_argument("--dry-run", action="store_true", help="validate with dummy secrets; write nothing")
    ap.add_argument("--tenant", help="tenant.toml path")
    ap.add_argument("--secrets", help="secrets env file path (default: $PD_SECRETS)")
    ap.add_argument("--out", help="output path (must be outside the repo)")
    ap.add_argument("--pubkey-file", help="override SSH_PUBKEY_PATH")
    ap.add_argument("--skip-yaml-check", action="store_true", help="dry-run only: skip the PyYAML check")
    ap.add_argument("--hash-env", default="PDADMIN_HASH", help="env var holding a ready $6$ hash")
    args = ap.parse_args()

    if args.skip_yaml_check and not args.dry_run:
        die("--skip-yaml-check is allowed only together with --dry-run")
    try:
        data = tenant.load(args.tenant)
        hostname = str(tenant.get(data, "tenant.hostname"))
        admin_user = str(tenant.get(data, "server.admin_user", TEMPLATE_ADMIN_USER))
        hours = int(tenant.get(data, "infra.bootstrap_ssh_hours", 6))
    except tenant.TenantError as exc:
        die(str(exc))

    out = Path(args.out) if args.out else Path(tempfile.gettempdir()) / "pd-cloud-init" / "user-data.yaml"
    if inside_repo(out):
        die(f"refusing to write inside the repository ({out}). Choose a path outside {REPO_ROOT}.")

    # SSH public key path and ADMIN_IP: flag > env > secrets file
    key_path = args.pubkey_file or os.environ.get("SSH_PUBKEY_PATH")
    admin_ip = os.environ.get("ADMIN_IP", "")
    if not key_path or not admin_ip:
        sp = tenant.secrets_path(args.secrets)
        if sp and sp.is_file():
            env = tenant.load_env_file(sp)
            key_path = key_path or env.get("SSH_PUBKEY_PATH")
            admin_ip = admin_ip or env.get("ADMIN_IP", "")
    if args.dry_run:
        pubkey = read_pubkey(key_path) if key_path and Path(key_path).expanduser().is_file() else DRY_KEY
        pw_hash = DRY_HASH
        bootstrap = bootstrap_line(admin_ip or DRY_ADMIN_IP, hours, True)
        print("[dry-run] using dummy hash" + ("" if key_path and Path(key_path).expanduser().is_file() else " and dummy key"))
    else:
        if not key_path:
            die("SSH_PUBKEY_PATH not set (secrets file or environment)")
        pubkey = read_pubkey(key_path)
        if not admin_ip:
            die("ADMIN_IP not set (secrets file or environment): the first-boot SSH window needs it")
        bootstrap = bootstrap_line(admin_ip, hours, False)
        pw_hash = obtain_hash(args.hash_env)

    try:
        fw_nft = fwrender.render_from_files(args.tenant, None)
    except fwrender.RenderError as exc:
        die(f"host firewall: {exc}")
    text = render(hostname, admin_user, pubkey, pw_hash, bootstrap, fw_nft)
    note = validate_yaml(text, args.skip_yaml_check)
    print(f"template     : {TEMPLATE.relative_to(REPO_ROOT)}")
    print(f"hostname     : {hostname}")
    print(f"admin user   : {admin_user}")
    print(f"ssh key      : {'(dummy)' if pubkey == DRY_KEY else pubkey.split()[0] + ' ... ' + (pubkey.split()[-1] if len(pubkey.split()) > 2 else '')}")
    print(f"password hash: {'(dummy)' if pw_hash == DRY_HASH else 'supplied (not shown)'}")
    print(f"bootstrap ssh: {bootstrap.split(',')[-1].strip(' ]')}  (host firewall, then tailnet only)")
    print(f"validation   : {note}")

    if args.dry_run:
        print(f"[dry-run] would write {len(text)} bytes to {out}")
        return 0

    out.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
    try:
        os.chmod(out, 0o600)
    except OSError:
        pass
    print(f"wrote        : {out}  (contains a password hash: delete after use)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
