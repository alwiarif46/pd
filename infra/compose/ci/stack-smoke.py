#!/usr/bin/env python3
"""Smoke checks for the Compose local stack (infra/compose/local.yml). CI job `compose-stack` runs them after `up --wait`.

    python3 infra/compose/ci/stack-smoke.py [--env-file infra/compose/local.env] <check> [<check> ...]
    checks: postgres schemas clamav s3 zitadel sandbox all   (schemas needs `pnpm migrate` to have run first)

--env-file reads KEY=VALUE lines (inline "# comments" allowed) and fills any variable the environment does not set.

Standard library only (no pip install on the runner). Settings come from the environment, with the local.env.example
defaults, so the script also runs against the test doubles of the native stack (clamav and s3 only):
    CLAMAV_HOST (127.0.0.1)  CLAMAV_PORT (3310)
    S3_ENDPOINT (http://127.0.0.1:8333)  S3_ACCESS_KEY  S3_SECRET_KEY  S3_BUCKET (pd-local)  S3_REGION (us-east-1)
    ZITADEL_URL (http://localhost:8080)
    COMPOSE_FILE_ARGS: the docker compose arguments up to the subcommand (needed by postgres, schemas and sandbox);
      --env-file sets it to "-f infra/compose/local.yml --env-file <that file>"
    ZITADEL_BOOTSTRAP_VOLUME (pd-local_zitadel_bootstrap)
Each check prints one line per assertion and raises on the first failure. Exit 0: every requested check passed.
"""
import datetime
import hashlib
import hmac
import json
import os
import shlex
import socket
import struct
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

# The EICAR test string, built from parts so this file is not flagged by a virus scanner on a developer machine.
EICAR = b"".join([b"X5O!P%@AP[4\\PZX54(P^)7CC)7}$", b"EICAR-STANDARD-ANTIVIRUS-TEST-FILE!", b"$H+H*"])


def load_env_file(path):
    """Fills os.environ (without overriding) from a Compose-style env file, then derives the endpoints from its ports."""
    for line in Path(path).read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.split(" #", 1)[0].strip()
        os.environ.setdefault(key.strip(), value)
    compose_yml = Path(__file__).resolve().parents[1] / "local.yml"
    os.environ.setdefault("COMPOSE_FILE_ARGS", shlex.join(["-f", str(compose_yml), "--env-file", str(Path(path).resolve())]))
    os.environ.setdefault("CLAMAV_HOST", "127.0.0.1")
    os.environ.setdefault("S3_ENDPOINT", f"http://127.0.0.1:{os.environ.get('S3_PORT', '8333')}")
    os.environ.setdefault("ZITADEL_URL", f"http://localhost:{os.environ.get('ZITADEL_PORT', '8080')}")


def env(name, default=None):
    value = os.environ.get(name, default)
    if value is None:
        raise SystemExit(f"{name} is not set")
    return value


def ok(message):
    print(f"ok   {message}", flush=True)


class CheckFailed(Exception):
    pass


def require(condition, message):
    if not condition:
        raise CheckFailed(message)


# ---------------------------------------------------------------- ClamAV (clamd protocol over TCP)

def clamd(command, payload=None):
    """One clamd exchange in the null-terminated `z` form. payload: bytes for INSTREAM."""
    host, port = env("CLAMAV_HOST", "127.0.0.1"), int(env("CLAMAV_PORT", "3310"))
    with socket.create_connection((host, port), timeout=30) as sock:
        sock.settimeout(60)
        sock.sendall(b"z" + command.encode() + b"\0")
        if payload is not None:
            sock.sendall(struct.pack(">I", len(payload)) + payload)
            sock.sendall(struct.pack(">I", 0))
        reply = b""
        while not reply.endswith(b"\0"):
            chunk = sock.recv(4096)
            if not chunk:
                break
            reply += chunk
    return reply.rstrip(b"\0\n").decode("latin1")


def check_clamav():
    require(clamd("PING") == "PONG", "clamd PING did not answer PONG")
    ok("clamd answers PING")
    version = clamd("VERSION")
    require(version.startswith("ClamAV"), f"unexpected VERSION reply: {version!r}")
    ok(f"clamd version: {version}")
    clean = clamd("INSTREAM", b"hello, this is a clean file\n")
    require(clean.endswith("OK"), f"a clean stream was not OK: {clean!r}")
    ok("a clean stream scans OK")
    eicar = clamd("INSTREAM", EICAR)
    require(eicar.endswith("FOUND") and "Eicar" in eicar, f"the EICAR test string was not found: {eicar!r}")
    ok(f"EICAR is detected: {eicar}")


# ---------------------------------------------------------------- S3 (path-style, AWS Signature V4, no dependencies)

def _hmac(key, text):
    return hmac.new(key, text.encode(), hashlib.sha256).digest()


def sigv4_headers(method, url, body, access_key, secret_key, region, now=None):
    """The headers that sign an S3 request. Path-style URL, no query string needed here."""
    parts = urllib.parse.urlsplit(url)
    now = now or datetime.datetime.now(datetime.timezone.utc)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date = amz_date[:8]
    payload_hash = hashlib.sha256(body).hexdigest()
    canonical_uri = urllib.parse.quote(urllib.parse.unquote(parts.path) or "/", safe="/-_.~")
    canonical_query = "&".join(
        f"{urllib.parse.quote(k, safe='-_.~')}={urllib.parse.quote(v, safe='-_.~')}"
        for k, v in sorted(urllib.parse.parse_qsl(parts.query, keep_blank_values=True))
    )
    headers = {"host": parts.netloc, "x-amz-content-sha256": payload_hash, "x-amz-date": amz_date}
    signed = ";".join(sorted(headers))
    canonical_headers = "".join(f"{k}:{headers[k]}\n" for k in sorted(headers))
    canonical_request = "\n".join([method, canonical_uri, canonical_query, canonical_headers, signed, payload_hash])
    scope = f"{date}/{region}/s3/aws4_request"
    to_sign = "\n".join(["AWS4-HMAC-SHA256", amz_date, scope, hashlib.sha256(canonical_request.encode()).hexdigest()])
    key = _hmac(_hmac(_hmac(_hmac(("AWS4" + secret_key).encode(), date), region), "s3"), "aws4_request")
    signature = hmac.new(key, to_sign.encode(), hashlib.sha256).hexdigest()
    return {
        "x-amz-date": amz_date,
        "x-amz-content-sha256": payload_hash,
        "Authorization": f"AWS4-HMAC-SHA256 Credential={access_key}/{scope}, SignedHeaders={signed}, Signature={signature}",
    }


def s3_request(method, path, body=b""):
    endpoint = env("S3_ENDPOINT", "http://127.0.0.1:8333").rstrip("/")
    url = endpoint + path
    headers = sigv4_headers(method, url, body, env("S3_ACCESS_KEY"), env("S3_SECRET_KEY"), env("S3_REGION", "us-east-1"))
    request = urllib.request.Request(url, data=body if method in ("PUT", "POST") else None, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as err:
        return err.code, err.read()


def check_s3():
    bucket = env("S3_BUCKET", "pd-local")
    status, body = s3_request("HEAD", f"/{bucket}")
    require(status == 200, f"HEAD bucket {bucket} -> {status}: the s3-init service should have created it. {body[:300]!r}")
    ok(f"bucket {bucket} exists (made by s3-init)")
    key = f"ci-smoke/{os.getpid()}.txt"
    payload = b"pd compose stack smoke test\n" * 100
    status, body = s3_request("PUT", f"/{bucket}/{key}", payload)
    require(status in (200, 201), f"PUT {key} -> {status}: {body[:300]!r}")
    ok(f"PUT {key} ({len(payload)} bytes)")
    status, body = s3_request("GET", f"/{bucket}/{key}")
    require(status == 200 and body == payload, f"GET {key} -> {status}, {len(body)} bytes, expected the {len(payload)} bytes written")
    ok("GET returns the same bytes")
    status, body = s3_request("DELETE", f"/{bucket}/{key}")
    require(status in (200, 204), f"DELETE {key} -> {status}: {body[:300]!r}")
    status, _ = s3_request("GET", f"/{bucket}/{key}")
    require(status == 404, f"GET after DELETE -> {status}, expected 404")
    ok("DELETE removes the object")
    # A request with the wrong secret must be refused (the gateway checks credentials), unless this is a test double.
    if os.environ.get("S3_EXPECT_AUTH", "1") == "1":
        endpoint = env("S3_ENDPOINT", "http://127.0.0.1:8333").rstrip("/")
        url = f"{endpoint}/{bucket}/ci-smoke/unsigned.txt"
        bad = sigv4_headers("GET", url, b"", env("S3_ACCESS_KEY"), "wrong-" + env("S3_SECRET_KEY"), env("S3_REGION", "us-east-1"))
        try:
            urllib.request.urlopen(urllib.request.Request(url, headers=bad), timeout=30)
            raise CheckFailed("a request signed with the wrong secret was accepted: the S3 gateway is not checking credentials")
        except urllib.error.HTTPError as err:
            require(err.code in (401, 403), f"a wrong signature gave {err.code}, expected 403")
        ok("a wrong signature is refused")


# ---------------------------------------------------------------- Zitadel

def http_get(url, headers=None):
    request = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as err:
        return err.code, err.read()


def check_zitadel():
    base = env("ZITADEL_URL", "http://localhost:8080").rstrip("/")
    status, body = http_get(base + "/debug/ready")
    require(status == 200, f"{base}/debug/ready -> {status}: {body[:300]!r}")
    ok("zitadel /debug/ready is 200")
    status, body = http_get(base + "/.well-known/openid-configuration")
    require(status == 200, f"{base}/.well-known/openid-configuration -> {status}: {body[:300]!r}")
    issuer = json.loads(body).get("issuer")
    require(issuer == base, f"issuer is {issuer!r}, expected {base!r} (ZITADEL_EXTERNALDOMAIN/PORT/SECURE)")
    ok(f"OIDC discovery answers, issuer {issuer}")
    volume = env("ZITADEL_BOOTSTRAP_VOLUME", "pd-local_zitadel_bootstrap")
    out = run(["docker", "run", "--rm", "-v", f"{volume}:/k:ro", "alpine:3.20", "cat", "/k/identity-sa.json"])
    key = json.loads(out)
    require(key.get("type") == "serviceaccount" and key.get("keyId") and key.get("key"), "identity-sa.json is not a machine key (type, keyId, key)")
    ok("the identity machine key was written to the zitadel_bootstrap volume (contents not printed)")


# ---------------------------------------------------------------- docker bound checks

def run(argv, check=True):
    result = subprocess.run(argv, capture_output=True, text=True)
    if check and result.returncode != 0:
        raise CheckFailed(f"{' '.join(argv)} exited {result.returncode}\n{result.stdout}\n{result.stderr}")
    return result.stdout


def compose(*args, check=True):
    return run(["docker", "compose", *shlex.split(env("COMPOSE_FILE_ARGS")), *args], check=check)


def check_postgres():
    out = compose("exec", "-T", "postgres", "psql", "-U", env("POSTGRES_USER", "postgres"), "-d", env("E2E_DB_NAME", "e2e"),
                  "-Atc", "select extname from pg_extension where extname = 'vector'")
    require(out.strip() == "vector", f"the vector extension is not enabled in {env('E2E_DB_NAME', 'e2e')}: {out!r}")
    ok("pgvector: extension vector is enabled in the e2e database")
    out = compose("exec", "-T", "postgres", "psql", "-U", env("POSTGRES_USER", "postgres"), "-d", "postgres",
                  "-Atc", "select count(*) from pg_database where datname in ('e2e', 'zitadel')")
    require(out.strip() == "2", f"expected the e2e and zitadel databases, got {out!r}")
    ok("the e2e and zitadel databases exist")


def check_schemas():
    services = json.loads((Path(__file__).resolve().parents[3] / "packages" / "contracts" / "services.json").read_text())
    expected = sorted(["app"] + [svc["schema"] for svc in services if svc.get("schema")])
    out = compose("exec", "-T", "postgres", "psql", "-U", env("POSTGRES_USER", "postgres"), "-d", env("E2E_DB_NAME", "e2e"),
                  "-Atc", "select nspname from pg_namespace where nspname = any(%s) order by 1" % "array['" + "','".join(expected) + "']")
    found = out.split()
    require(found == expected, f"schemas after pnpm migrate: expected {expected}, found {found}")
    ok(f"all {len(expected)} schemas exist in the e2e database")


def check_sandbox():
    container = compose("ps", "-q", "sandbox").strip()
    require(container, "no sandbox container (docker compose ps -q sandbox is empty)")
    info = json.loads(run(["docker", "inspect", container]))[0]
    state = info["State"]
    require(state.get("Running"), f"sandbox is not running: {state.get('Status')}, exit {state.get('ExitCode')}, {state.get('Error')}")
    ok("the sandbox container is running")
    host = info["HostConfig"]
    require(host["NetworkMode"] == "none", f"NetworkMode is {host['NetworkMode']!r}, expected 'none'")
    require(host.get("ReadonlyRootfs") is True, "the root filesystem is not read-only")
    require("ALL" in (host.get("CapDrop") or []), f"CapDrop is {host.get('CapDrop')!r}, expected ALL")
    require("no-new-privileges:true" in (host.get("SecurityOpt") or []), f"SecurityOpt is {host.get('SecurityOpt')!r}")
    ok("hardening: network none, read-only root, all capabilities dropped, no-new-privileges")
    # From inside: only loopback, and an outbound request fails. Node is in the image; the script prints one word.
    probe = (
        "const os=require('os');"
        "const ext=Object.values(os.networkInterfaces()).flat().filter(i=>i&&!i.internal).length;"
        "console.log('external-interfaces='+ext);"
        "console.log('uid='+process.getuid());"
        "fetch('http://example.com',{signal:AbortSignal.timeout(3000)}).then(()=>console.log('network=reachable'),()=>console.log('network=none'));"
    )
    out = compose("exec", "-T", "sandbox", "node", "-e", probe)
    require("external-interfaces=0" in out, f"the sandbox has a network interface: {out!r}")
    require("network=none" in out, f"the sandbox reached the internet: {out!r}")
    require("uid=1000" in out, f"the sandbox does not run as uid 1000: {out!r}")
    ok("inside the sandbox: no network interface, no outbound connection, uid 1000")
    out = compose("exec", "-T", "sandbox", "sh", "-c", "touch /should-fail 2>&1 || echo read-only", check=False)
    require("read-only" in out or "Read-only" in out, f"the sandbox root is writable: {out!r}")
    ok("the sandbox root filesystem is read-only")


CHECKS = {"postgres": check_postgres, "schemas": check_schemas, "clamav": check_clamav, "s3": check_s3, "zitadel": check_zitadel, "sandbox": check_sandbox}


def main(argv):
    if argv[:1] == ["--env-file"]:
        load_env_file(argv[1])
        argv = argv[2:]
    wanted = argv or ["all"]
    if wanted == ["all"]:
        wanted = list(CHECKS)
    unknown = [name for name in wanted if name not in CHECKS]
    if unknown:
        print(f"unknown check(s): {', '.join(unknown)}; choose from {', '.join(CHECKS)} or all", file=sys.stderr)
        return 2
    failed = []
    for name in wanted:
        print(f"== {name}", flush=True)
        try:
            CHECKS[name]()
        except (CheckFailed, OSError, urllib.error.URLError, json.JSONDecodeError, subprocess.SubprocessError) as err:
            print(f"FAIL {name}: {err}", file=sys.stderr, flush=True)
            failed.append(name)
    if failed:
        print(f"stack-smoke failed: {', '.join(failed)}", file=sys.stderr)
        return 1
    print("stack-smoke ok: " + ", ".join(wanted))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
