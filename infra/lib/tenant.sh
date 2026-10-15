# shellcheck shell=bash
# infra/lib/tenant.sh - shared helpers for every infra script.
# Implements: docs/plans/01-infrastructure.md (read tenant values from config/tenant.toml, never
# hard-code them) and docs/00-README.md section 9 rules 3 and 9 (no secrets in git,
# idempotent scripts with --dry-run).
#
# Source it; do not execute it:
#     SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#     # shellcheck source=../lib/tenant.sh
#     . "$SCRIPT_DIR/../lib/tenant.sh"
#     usage() { ...; }                       # optional; called for -h/--help
#     pd_parse_args "$@"                 # sets PD_DRY_RUN, PD_TENANT, PD_SECRETS
#     set -- ${PD_REST[@]+"${PD_REST[@]}"}   # remaining (script-specific) arguments
#     domain=$(tenant_get tenant.domain)
#     run openstack server list              # prints instead of executing under --dry-run
#
# Public interface (kept stable; other scripts depend on it):
#   tenant_get <section.key> [default]   value from $PD_TENANT or config/tenant.toml; dies if missing
#   load_secrets                         load the env file named by $PD_SECRETS (never echoes values)
#   require_secret NAME...               die unless each variable is set (dry-run: only notes it)
#   run <cmd> [args...]                  dry-run: print the command (secrets masked); else execute it
#   pd_parse_args "$@"               common --dry-run / --tenant PATH / --secrets PATH / -h parser
#   Helpers: pd_log pd_warn pd_die pd_mask_str pd_register_secret
#            pd_native_path pd_unix_path write_file need_root have
#            pyj '<python expr using d>'   evaluate an expression against JSON read from stdin
#
# Secrets file: tenant.secrets_file in config/tenant.toml (default local path), overridden by
# $PD_SECRETS / --secrets. Keys: OS_APPLICATION_CREDENTIAL_ID OS_APPLICATION_CREDENTIAL_SECRET
# (or OS_USERNAME OS_PASSWORD OS_PROJECT_ID; OVHcloud US OpenStack, infra/lib/openstack.sh)
# CLOUDFLARE_DNS_TOKEN B2_KEY_ID B2_APP_KEY SSH_PUBKEY_PATH ADMIN_IP, HCLOUD_TOKEN (Hetzner adapter, D-146).
# It is parsed as KEY=VALUE lines, never executed.

if [[ -n "${_PD_LIB_LOADED:-}" ]]; then
  return 0
fi
_PD_LIB_LOADED=1

PD_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PD_INFRA_DIR="$(cd "$PD_LIB_DIR/.." && pwd)"
PD_REPO_ROOT="$(cd "$PD_INFRA_DIR/.." && pwd)"
PD_DRY_RUN="${PD_DRY_RUN:-0}"
PD_REST=()
PD_SECRET_VALUES=()
PD_PY=""

# ---------------------------------------------------------------- logging

pd_log()  { printf '%s\n' "$*" >&2; }
pd_warn() { printf 'WARN: %s\n' "$*" >&2; }
pd_die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------- paths / python

# Convert a path for native Windows programs (python.exe, openstack.exe) when running under
# Git Bash; a no-op on Linux.
pd_native_path() {
  if have cygpath; then cygpath -m "$1"; else printf '%s' "$1"; fi
}

# Convert a possibly Windows-style path (C:\x\y) to something bash can test with [[ -f ]].
pd_unix_path() {
  case "$1" in
    [A-Za-z]:\\* | [A-Za-z]:/*)
      if have cygpath; then cygpath -u "$1"; else printf '%s' "$1"; fi ;;
    *) printf '%s' "$1" ;;
  esac
}

# Sets PD_PY to a working Python 3.11+ (tomllib). On Windows "python3" is often a Store stub,
# so each candidate is exercised, not just looked up.
pd_find_python() {
  [[ -n "$PD_PY" ]] && return 0
  local c
  for c in python3 python py; do
    if have "$c" && "$c" -c 'import tomllib' >/dev/null 2>&1; then
      PD_PY="$c"
      return 0
    fi
  done
  pd_die "no working Python 3.11+ found (need tomllib). Install python3 (Ubuntu 24.04 ships 3.12)."
}

# pyj '<expr>': read JSON on stdin as `d`, print eval(expr) (strings raw, everything else as JSON).
# Used to pick fields out of `openstack ... -f json` without needing jq. Expressions are written by
# the scripts themselves, never taken from user input.
pyj() {
  pd_find_python
  "$PD_PY" -c 'import sys, json; d = json.load(sys.stdin); r = eval(sys.argv[1]); print(r if isinstance(r, str) else json.dumps(r))' "$1"
}

# ---------------------------------------------------------------- tenant config

tenant_file() {
  printf '%s' "${PD_TENANT:-$PD_REPO_ROOT/config/tenant.toml}"
}

# tenant_get <section.key> [default]  - fails loudly on a missing key unless a default is given.
tenant_get() {
  [[ $# -ge 1 ]] || pd_die "tenant_get: key required (section.key)"
  pd_find_python
  local file
  file="$(pd_native_path "$(tenant_file)")"
  local args=(get "$1" --tenant "$file")
  if [[ $# -ge 2 ]]; then args+=(--default "$2"); fi
  local out
  if ! out="$("$PD_PY" "$(pd_native_path "$PD_LIB_DIR/tenant.py")" "${args[@]}")"; then
    pd_die "tenant_get $1 failed (tenant file: $(tenant_file))"
  fi
  printf '%s\n' "$out"
}

# ---------------------------------------------------------------- secrets

pd_register_secret() {
  # Remember a value so run/pd_mask_str can mask it. Ignore trivially short values.
  [[ ${#1} -ge 4 ]] || return 0
  PD_SECRET_VALUES+=("$1")
}

# Mask every registered secret value inside a string.
pd_mask_str() {
  local s="$1" v
  for v in ${PD_SECRET_VALUES[@]+"${PD_SECRET_VALUES[@]}"}; do
    s="${s//"$v"/***}"
  done
  printf '%s' "$s"
}

# Filter stdin through the mask (use for command output that might contain a secret).
pd_mask() {
  local line
  while IFS= read -r line || [[ -n "$line" ]]; do
    printf '%s\n' "$(pd_mask_str "$line")"
  done
}

# load_secrets - read $PD_SECRETS (or --secrets PATH). Missing file is fine under --dry-run.
load_secrets() {
  local f="${PD_SECRETS:-}"
  if [[ -z "$f" ]]; then
    local guess
    guess="$(tenant_get tenant.secrets_file "")"
    if [[ -n "$guess" && -f "$(pd_unix_path "$guess")" ]]; then f="$guess"; fi
  fi
  if [[ -z "$f" || ! -f "$(pd_unix_path "$f")" ]]; then
    if (( PD_DRY_RUN )); then
      pd_log "note: secrets file not found (fine for --dry-run). Set PD_SECRETS or --secrets PATH."
      return 0
    fi
    pd_die "secrets file not found. Set PD_SECRETS (or pass --secrets PATH) to the env file."
  fi
  f="$(pd_unix_path "$f")"
  # An exported PD_SECRETS (e.g. production's) silently beats the tenant's own secrets_file: say so when
  # the tenant names a different file that exists here (test tenant run with production keys, D-148).
  local own
  own="$(tenant_get tenant.secrets_file "")"
  if [[ -n "$own" ]]; then
    own="$(pd_unix_path "$own")"
    if [[ -f "$own" && "$(cd "$(dirname "$own")" && pwd)/$(basename "$own")" != "$(cd "$(dirname "$f")" && pwd)/$(basename "$f")" ]]; then
      pd_warn "using secrets file $f, but $(basename "$(tenant_file)") names $own: wrong keys for this tenant? (unset PD_SECRETS or pass --secrets)"
    fi
  fi
  export PD_SECRETS="$f"

  local line key val re='^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$'
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ $re ]] || continue
    key="${BASH_REMATCH[2]}"
    val="${BASH_REMATCH[3]}"
    # trim leading/trailing whitespace
    val="${val#"${val%%[![:space:]]*}"}"
    val="${val%"${val##*[![:space:]]}"}"
    if [[ ${#val} -ge 2 && ( ( "${val:0:1}" == '"' && "${val: -1}" == '"' ) || ( "${val:0:1}" == "'" && "${val: -1}" == "'" ) ) ]]; then
      val="${val:1:${#val}-2}"
    elif [[ "$val" == *" #"* ]]; then
      val="${val%% \#*}"
      val="${val%"${val##*[![:space:]]}"}"
    fi
    case "$key" in
      OS_APPLICATION_CREDENTIAL_SECRET | OS_PASSWORD | CLOUDFLARE_DNS_TOKEN | B2_KEY_ID | B2_APP_KEY | HCLOUD_TOKEN)
        export "$key=$val"
        pd_register_secret "$val" ;;
      OS_APPLICATION_CREDENTIAL_ID | OS_USERNAME | OS_PROJECT_ID | SSH_PUBKEY_PATH | ADMIN_IP)
        export "$key=$val" ;;
      *) ;;  # unknown keys are ignored on purpose
    esac
  done < "$f"
}

# require_secret NAME... - die if a variable is empty. Under --dry-run only report what is needed.
require_secret() {
  local n
  for n in "$@"; do
    if [[ -z "${!n:-}" ]]; then
      if (( PD_DRY_RUN )); then
        pd_log "note: $n is not set (needed for a real run, not for --dry-run)"
      else
        pd_die "$n is not set. Add it to the secrets file ($(basename "${PD_SECRETS:-$(tenant_get tenant.secrets_file "secrets.env")}"))."
      fi
    fi
  done
}

# ---------------------------------------------------------------- run / dry-run

# run <cmd> [args...]: under --dry-run prints the command (secrets masked) and returns 0.
run() {
  local a out=""
  local safe='^[A-Za-z0-9_./:=@%+,<>*-]+$' m
  for a in "$@"; do
    m="$(pd_mask_str "$a")"
    if [[ "$m" =~ $safe ]]; then out+="$m "; else out+="$(printf '%q' "$m") "; fi
  done
  out="${out% }"
  if (( PD_DRY_RUN )); then
    printf '[dry-run] %s\n' "$out"
    return 0
  fi
  printf '+ %s\n' "$out" >&2
  "$@"
}

need_root() {
  (( PD_DRY_RUN )) && return 0
  [[ "$(id -u)" -eq 0 ]] || pd_die "must run as root (use: sudo $0 ...)"
}

# write_file <path> <mode> [owner:group] < content
# Writes stdin to <path> only when the content or mode differs. Never prints the content.
write_file() {
  local path="$1" mode="$2" owner="${3:-root:root}"
  local tmp
  tmp="$(mktemp)"
  cat > "$tmp"
  local cur_mode=""
  if [[ -f "$path" ]]; then cur_mode="$(stat -c %a "$path" 2>/dev/null || true)"; fi
  if [[ -f "$path" ]] && cmp -s "$tmp" "$path" && [[ "$cur_mode" == "$mode" ]]; then
    pd_log "unchanged: $path"
    rm -f "$tmp"
    return 0
  fi
  if (( PD_DRY_RUN )); then
    printf '[dry-run] write %s (mode %s, owner %s, %s bytes)\n' "$path" "$mode" "$owner" "$(wc -c < "$tmp" | tr -d ' ')"
    rm -f "$tmp"
    return 0
  fi
  install -m "$mode" -o "${owner%%:*}" -g "${owner##*:}" "$tmp" "$path"
  rm -f "$tmp"
  pd_log "wrote: $path (mode $mode)"
}

# ---------------------------------------------------------------- argument parser

# pd_parse_args "$@": consumes --dry-run, --tenant PATH, --secrets PATH, -h/--help.
# Everything else lands in the PD_REST array in order.
pd_parse_args() {
  PD_REST=()
  while (( $# )); do
    case "$1" in
      --dry-run) PD_DRY_RUN=1 ;;
      --tenant)
        [[ $# -ge 2 ]] || pd_die "--tenant needs a path"
        export PD_TENANT="$2"; shift ;;
      --tenant=*) export PD_TENANT="${1#--tenant=}" ;;
      --secrets)
        [[ $# -ge 2 ]] || pd_die "--secrets needs a path"
        export PD_SECRETS="$2"; shift ;;
      --secrets=*) export PD_SECRETS="${1#--secrets=}" ;;
      -h | --help)
        if declare -F usage >/dev/null; then usage; else pd_log "no help available"; fi
        exit 0 ;;
      --) shift; PD_REST+=("$@"); break ;;
      *) PD_REST+=("$1") ;;
    esac
    shift
  done
  export PD_DRY_RUN
  if [[ -n "${PD_TENANT:-}" && ! -f "$PD_TENANT" ]]; then
    pd_die "tenant file not found: $PD_TENANT"
  fi
}
