# shellcheck shell=bash
# infra/lib/ops-common.sh - shared helpers for the plan 01 §4.1 / §6 / §8-§10 scripts
# (LUKS, firewall, DNS, backups, acceptance checks).
#
# Sourced, never executed. Builds on infra/lib/tenant.sh (tenant_get, run, pd_parse_args).
#
# Design notes
# - Every script parses the common flags with tenant.sh's pd_parse_args
#   (--dry-run, --tenant PATH, --secrets PATH, -h) and keeps its own flags in OPS_ARGS.
#   Commands go through tenant.sh's run() (prints under --dry-run, else executes).
# - Dry-run never writes, never needs root, and never touches devices. Read-only
#   probes (blkid, findmnt, docker inspect) still run when the tool is present, so a
#   dry-run on the server shows what a real run would change.
# - File writes go through ops_install_file: write only when content differs, keep a
#   timestamped backup of the old file, print a diff. That makes every script safe to
#   run twice (CLAUDE.md conventions rule 9).
# - Nothing in here reads or prints secrets.

set -o errexit -o nounset -o pipefail

OPS_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRY_RUN=0
OPS_ARGS=()

# shellcheck source=tenant.sh
source "$OPS_LIB_DIR/tenant.sh"

log()  { printf '[%s] %s\n' "${OPS_NAME:-pd}" "$*" >&2; }
warn() { printf '[%s] WARNING: %s\n' "${OPS_NAME:-pd}" "$*" >&2; }
die()  { printf '[%s] ERROR: %s\n' "${OPS_NAME:-pd}" "$*" >&2; exit 1; }

is_dry() { [[ "$DRY_RUN" == "1" ]]; }

# ops_init NAME "$@" -> common flags via tenant.sh's pd_parse_args
# (--dry-run, --tenant PATH, --secrets PATH, -h); the rest lands in OPS_ARGS.
# Callers define usage() before calling it.
ops_init() {
  OPS_NAME="$1"; shift
  pd_parse_args "$@"
  OPS_ARGS=(${PD_REST[@]+"${PD_REST[@]}"})
  DRY_RUN="$PD_DRY_RUN"
  is_dry && log "dry-run: nothing will be changed"
  return 0
}

# Value from tenant.toml; dies if empty.
tget() {
  local v
  v="$(tenant_get "$1")" || die "tenant_get $1 failed"
  [[ -n "$v" ]] || die "tenant.toml: $1 is empty"
  printf '%s' "$v"
}

# List value from tenant.toml, one item per line (tenant.py prints lists that way).
# The trailing newline matters: $(...) strips it, so printf puts it back and "while read" loops
# see the last item. tget runs outside the pipe so its failure is not masked.
tget_list() {
  local v
  v="$(tget "$1")" || exit 1
  printf '%s\n' "$v" | sed '/^[[:space:]]*$/d'
}

require_root() {
  is_dry && return 0
  [[ "$(id -u)" -eq 0 ]] || die "run as root (sudo)"
}

require_cmd() {
  local c
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || { is_dry && { warn "command not found: $c (ignored in dry-run)"; continue; }; die "command not found: $c"; }
  done
}

# ops_install_file DEST MODE OWNER:GROUP  < content
# Idempotent: writes only when content differs; backs up the previous version.
ops_install_file() {
  local dest="$1" mode="$2" owner="$3" tmp
  tmp="$(mktemp)"
  cat >"$tmp"
  # No managed file is ever empty: empty input means the generator failed upstream.
  [[ -s "$tmp" ]] || { rm -f "$tmp"; die "refusing to write empty content to $dest"; }
  if [[ -f "$dest" ]] && cmp -s "$tmp" "$dest"; then
    log "unchanged: $dest"
    rm -f "$tmp"; return 0
  fi
  if is_dry; then
    if [[ -f "$dest" ]]; then
      log "would update $dest (mode $mode, $owner):"
      diff -u "$dest" "$tmp" >&2 || true
    else
      log "would create $dest (mode $mode, $owner):"
      sed 's/^/    | /' "$tmp" >&2
    fi
    rm -f "$tmp"; return 0
  fi
  if [[ -f "$dest" ]]; then
    cp -p "$dest" "$dest.bak.$(date -u +%Y%m%dT%H%M%SZ)"
    diff -u "$dest" "$tmp" >&2 || true
  fi
  install -D -m "$mode" -o "${owner%%:*}" -g "${owner##*:}" "$tmp" "$dest"
  rm -f "$tmp"
  log "wrote $dest"
}

# ops_install_cmd DEST MODE OWNER:GROUP CMD [ARGS...]
# Runs CMD into a temp file and installs it only if CMD succeeded. Use this instead of
# "CMD | ops_install_file": in a pipe a failing generator would still feed a truncated
# file to the installer before pipefail stops the script.
ops_install_cmd() {
  local dest="$1" mode="$2" owner="$3" tmp; shift 3
  tmp="$(mktemp)"
  if ! "$@" >"$tmp"; then rm -f "$tmp"; die "generating $dest failed; nothing written"; fi
  ops_install_file "$dest" "$mode" "$owner" <"$tmp"
  rm -f "$tmp"
}

# Render a template: replaces {{KEY}} with values passed as KEY=VALUE args.
# Fails if any {{...}} placeholder is left.
ops_render() {
  local tpl="$1"; shift
  [[ -r "$tpl" ]] || die "template not found: $tpl"
  pd_find_python
  "$PD_PY" - "$(pd_native_path "$tpl")" "$@" <<'PY'
import re, sys
tpl = open(sys.argv[1], encoding="utf-8", newline="").read()
for kv in sys.argv[2:]:
    k, v = kv.split("=", 1)
    tpl = tpl.replace("{{" + k + "}}", v)
left = sorted(set(re.findall(r"\{\{[A-Z0-9_]+\}\}", tpl)))
if left:
    sys.exit("unrendered placeholders: " + ", ".join(left))
sys.stdout.buffer.write(tpl.encode("utf-8"))
PY
}

# Ask a yes/no question on the terminal; refuses when there is no terminal.
confirm_tty() {
  local prompt="$1" ans
  [[ -t 0 ]] || die "needs an interactive terminal: $prompt"
  read -r -p "$prompt [type yes]: " ans
  [[ "$ans" == "yes" ]]
}

# Print a script's header comment (line 2 up to the first non-comment line) as help.
ops_usage() { awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$1"; }

# Short host name, portable (Git Bash `hostname` has no -s).
short_host() { hostname 2>/dev/null | cut -d. -f1; }

# HTTP/2 syntax depends on the nginx version: "http2 on;" exists from 1.25.1; older
# nginx (Ubuntu 24.04 ships 1.24.0) needs "listen ... ssl http2". Sets NGX_VERSION,
# HTTP2_LISTEN (" http2" or "") and HTTP2_DIRECTIVE ("    http2 on;" or "").
# Version: $1, else the local nginx, else 1.24.0 (Ubuntu 24.04).
ops_nginx_http2() {
  NGX_VERSION="${1:-}"
  if [[ -z "$NGX_VERSION" ]] && have nginx; then
    NGX_VERSION="$(nginx -v 2>&1 | sed -nE 's|.*nginx/([0-9]+\.[0-9]+\.[0-9]+).*|\1|p')"
  fi
  NGX_VERSION="${NGX_VERSION:-1.24.0}"
  if [[ "$(printf '%s\n%s\n' 1.25.1 "$NGX_VERSION" | sort -V | head -1)" == 1.25.1 ]]; then
    HTTP2_LISTEN=""; HTTP2_DIRECTIVE="    http2 on;"
  else
    HTTP2_LISTEN=" http2"; HTTP2_DIRECTIVE=""
  fi
}
