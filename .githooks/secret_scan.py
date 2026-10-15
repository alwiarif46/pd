"""Secret scan for the PD repo (ported from Drive's .githooks/secret_scan.py, PR #3).

Usage:
  secret_scan.py --staged        scan files staged for commit (pre-commit hook)
  secret_scan.py --all           scan every tracked file
  secret_scan.py PATH [PATH...]  scan given files

Exit 1 if anything looks like a secret. A line can be allowed with the marker
`secret-scan: allow` when it is a documented placeholder.
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

BLOCKED_NAMES = re.compile(
    r"(^|/)(\.env(\..+)?|.*\.env|.*\.key|.*\.pem|.*\.p12|.*\.pfx|.*\.luksheader|id_(rsa|ed25519|ecdsa)(\.pub)?|cloudflare\.ini)$"
)
ALLOWED_NAMES = re.compile(r"\.env\.example$")

PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("private key block", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("sha-512 crypt hash", re.compile(r"\$6\$(?!REPLACE)[A-Za-z0-9./]{8,16}\$[A-Za-z0-9./]{40,}")),
    ("Hetzner API token", re.compile(r"(?i)hcloud[_-]?token\s*[=:]\s*['\"]?[A-Za-z0-9]{64}")),
    ("OpenStack credential secret", re.compile(r"(?i)\bOS_(APPLICATION_CREDENTIAL_SECRET|PASSWORD)\s*[=:]\s*['\"]?[A-Za-z0-9_+/=-]{24,}")),
    ("Cloudflare API token", re.compile(r"(?i)(dns_cloudflare_api_token|cf[_-]?api[_-]?token|cloudflare[_-]?token)\s*[=:]\s*['\"]?[A-Za-z0-9_-]{40}")),
    ("Backblaze application key", re.compile(r"\bK00[0-9][A-Za-z0-9+/]{27,}")),
    ("AWS-style key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("GitHub token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{36,}\b")),
    ("Slack token", re.compile(r"\bxox[abpr]-[A-Za-z0-9-]{10,}")),
    ("Tailscale/Headscale auth key", re.compile(r"\b(tskey-auth-[A-Za-z0-9-]{10,}|hskey-auth-[A-Za-z0-9_-]{10,})")),
    ("ssh public key with real body", re.compile(r"ssh-(ed25519|rsa) AAAA[A-Za-z0-9+/]{40,}")),
    # PD-specific token shapes
    ("Stripe live key", re.compile(r"\b(sk|rk)_live_[A-Za-z0-9]{20,}")),
    ("Stripe webhook secret", re.compile(r"\bwhsec_[A-Za-z0-9]{20,}")),
    ("Anthropic API key", re.compile(r"\bsk-ant-[A-Za-z0-9_-]{20,}")),
    ("Telnyx API key", re.compile(r"\bKEY0[0-9A-F]{20,}")),
    ("Postgres URL with a password", re.compile(r"postgres(ql)?://[^:\s]+:(?!\$\{|password@|<)[^@\s]{8,}@")),
    (
        "assignment of a long secret",
        re.compile(
            r"(?i)\b(password|passphrase|secret|api[_-]?key|token|app[_-]?password)\b\s*[=:]\s*['\"]([^'\"\s<>{}$]{16,})['\"]"
        ),
    ),
]
ALLOW_MARK = "secret-scan: allow"
PLACEHOLDER = re.compile(r"(?i)(REPLACE|CHANGEME|CHANGE_THIS|EXAMPLE|PLACEHOLDER|xxxx|<[^>]+>|\$\{?[A-Z_]+\}?|dummy|fake|test-only)")
# Test code carries long literal fixtures; only the generic "assignment of a long secret" pattern is relaxed
# there. Every token-shape pattern above stays on for tests.
TEST_PATH = re.compile(r"(^|/)(test|tests|__tests__)/|\.test\.tsx?$|/tests/fakes/")


def git(*args: str) -> str:
    out = subprocess.run(["git", *args], check=True, capture_output=True).stdout
    return out.decode("utf-8", errors="ignore")


def staged_files() -> list[str]:
    out = git("diff", "--cached", "--name-only", "--diff-filter=ACMR")
    return [p for p in out.splitlines() if p]


def staged_content(path: str) -> str:
    try:
        return git("show", f":{path}")
    except subprocess.CalledProcessError:
        return ""


def scan_text(path: str, text: str) -> list[str]:
    hits: list[str] = []
    norm = path.replace("\\", "/")
    if BLOCKED_NAMES.search(norm) and not ALLOWED_NAMES.search(norm):
        hits.append(f"{path}: file name is on the secrets block list")
    in_tests = bool(TEST_PATH.search(norm))
    for lineno, line in enumerate(text.splitlines(), 1):
        if ALLOW_MARK in line:
            continue
        for label, pat in PATTERNS:
            if in_tests and label == "assignment of a long secret":
                continue
            m = pat.search(line)
            if not m:
                continue
            if label == "assignment of a long secret" and PLACEHOLDER.search(m.group(0)):
                continue
            hits.append(f"{path}:{lineno}: possible {label}")
    return hits


def main(argv: list[str]) -> int:
    if not argv or argv[0] == "--staged":
        files = staged_files()
        read = staged_content
    elif argv[0] == "--all":
        files = [p for p in git("ls-files").splitlines() if p and Path(p).is_file()]
        read = lambda p: Path(p).read_text(encoding="utf-8", errors="ignore")  # noqa: E731
    else:
        files = argv
        read = lambda p: Path(p).read_text(encoding="utf-8", errors="ignore")  # noqa: E731

    hits: list[str] = []
    for f in files:
        if f.endswith("secret_scan.py"):
            continue
        hits.extend(scan_text(f, read(f)))
    if hits:
        print("Secret scan blocked this commit:", file=sys.stderr)
        for h in hits:
            print("  " + h, file=sys.stderr)
        print(f"If a line is a documented placeholder, add the comment '{ALLOW_MARK}'.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
