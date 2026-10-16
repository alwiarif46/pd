# shellcheck shell=bash
# shellcheck disable=SC2034  # a sourced library: ORIG_PATH and the counters are read by the runners that source it
# ops/tests/lib.sh - shared harness for infra/tests/*.sh and ops/tests/run-tests.sh (sourced, never executed).
#
# Rules every runner follows (Drive D-150 and the PD safety rules):
#   - stdin is /dev/null: nothing under test may wait for input
#   - the suite aborts if a test fake is not executable (a fake without +x is skipped by PATH lookup and the REAL
#     curl / ssh / docker would run) - checked in the working tree and in the git index (mode 100755)
#   - fakes come first on PATH; the real network is never used (PD_HCLOUD_API / PD_CLOUDFLARE_API point at local fakes)
#   - no test runs `cryptsetup luksFormat`, losetup, mkfs or nft against the machine: the static guard below (NO-LUKSFORMAT-GUARD)
#     fails the suite if the word appears in a test file outside a line marked NO-LUKSFORMAT-GUARD
#   - Python 3.11+ is required; when none is found the suite SKIPS and exits 0 (never fails for a missing tool)
#
# Provides: ok bad skip summary, PASS FAIL SKIPPED counters, REPO, TMP, PY, ORIG_PATH, guard_fakes, guard_no_luksformat.

exec </dev/null
# TMP is also an environment variable on Windows (the user's real temp directory): never trust an inherited value.
TMP=""
# cleanup_tmp: remove only a directory this harness created with mktemp -d (name tmp.XXXXXXXXXX). Anything else is left alone.
cleanup_tmp() {
  case "${TMP:-}" in
    */tmp.??????????) [[ -d "$TMP" ]] && rm -rf "$TMP" ;;
  esac
  return 0
}
PASS=0 FAIL=0 SKIPPED=0
ok()   { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$1"; }
bad()  { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n' "$1"; [[ -n "${2:-}" ]] && printf '      %s\n' "$2"; return 0; }
skip() { SKIPPED=$((SKIPPED + 1)); printf 'SKIP  %s\n' "$1"; }
summary() {
  printf '\n%d passed, %d failed, %d skipped\n' "$PASS" "$FAIL" "$SKIPPED"
  (( FAIL == 0 ))
}

# find_python: first candidate that really runs Python 3.11+ (Windows Store stubs exist but do not run).
find_python() {
  local c
  for c in python3 python py; do
    command -v "$c" >/dev/null 2>&1 && "$c" -c 'import tomllib' >/dev/null 2>&1 && { printf '%s' "$c"; return 0; }
  done
  return 1
}

# harness_init REPO_DIR: sets REPO, TMP (with an EXIT trap), ORIG_PATH, PY. Skips the suite when there is no Python.
harness_init() {
  REPO="$1"
  TMP="$(mktemp -d)"
  case "$TMP" in */tmp.??????????) ;; *) echo "ABORT: mktemp -d returned an unexpected path ($TMP)"; TMP=""; exit 1 ;; esac
  trap cleanup_tmp EXIT
  ORIG_PATH="$PATH"
  PY="$(find_python)" || { echo "SKIP  whole suite: no working Python 3.11+ on this machine (install python3 or run in CI)"; exit 0; }
  export FAKE_PY="$PY"
  cd "$REPO" || exit 1
}

# guard_fakes: D-150. Every non-.py file under */tests/fakes/ must be executable in the tree AND mode 100755 in the index.
guard_fakes() {
  local f mode missing=0
  while IFS= read -r f; do
    case "$f" in *.py | *__pycache__*) continue ;; esac
    [[ -x "$f" ]] || { printf 'GUARD  fake is not executable in the working tree: %s\n' "$f"; missing=1; }
  done < <(find "$REPO" -path '*/tests/fakes/*' -type f -not -path '*/node_modules/*' 2>/dev/null)
  # Under sudo (CI runs test-root-container.sh as root) git refuses a checkout owned by another user ("dubious
  # ownership") and rev-parse fails: the index check would be skipped silently. So the repository is named safe on
  # the command line for these read-only calls, and a checkout git still cannot read aborts the suite.
  local git_ro=(git -c "safe.directory=$REPO" -C "$REPO")
  if [[ -e "$REPO/.git" ]] && ! command -v git >/dev/null 2>&1; then
    echo "ABORT: $REPO is a git checkout but git is not installed: cannot check the fakes' mode in the index (Drive D-150)"; exit 1
  fi
  if [[ -e "$REPO/.git" ]] && ! "${git_ro[@]}" rev-parse --git-dir >/dev/null 2>&1; then
    echo "ABORT: git cannot read $REPO (as $(id -un 2>/dev/null || echo ?)): cannot check the fakes' mode in the index (Drive D-150)"; exit 1
  fi
  if command -v git >/dev/null 2>&1 && "${git_ro[@]}" rev-parse --git-dir >/dev/null 2>&1; then
    while IFS=$'\t' read -r meta f; do
      mode="${meta%% *}"
      case "$f" in */tests/fakes/*.py | */tests/fakes/__pycache__/*) continue ;; */tests/fakes/*) ;; *) continue ;; esac
      [[ "$mode" == 100755 ]] || { printf 'GUARD  fake is mode %s in the git index, need 100755: %s (run ops/ci/set-exec-bits.sh)\n' "$mode" "$f"; missing=1; }
    done < <("${git_ro[@]}" ls-files -s)
  fi
  if (( missing )); then
    echo "ABORT: a test fake without the executable bit would let the real tool run (Drive D-150). Run ops/ci/set-exec-bits.sh."
    exit 1
  fi
  ok "D-150 guard: every test fake is executable (tree and index)"
}

# guard_no_luksformat: no test file may run luksFormat; the only allowed lines carry the marker. (NO-LUKSFORMAT-GUARD)
guard_no_luksformat() {
  local hits
  hits="$(grep -rn 'luksFormat' "$REPO/infra/tests" "$REPO/ops/tests" 2>/dev/null | grep -v 'NO-LUKSFORMAT-GUARD' || true)"
  if [[ -z "$hits" ]]; then ok "no test runs luksFormat (static guard)"; else bad "luksFormat appears in a test file without the NO-LUKSFORMAT-GUARD marker" "$hits"; fi
}
