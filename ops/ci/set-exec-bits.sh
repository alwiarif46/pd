#!/usr/bin/env bash
# ops/ci/set-exec-bits.sh - set the executable bit in the git index for every tracked *.sh, the git hooks
# and the extension-less test fakes that tests put on PATH (*/tests/fakes/*, */tests/fake-*).
# Windows checkouts do not carry mode bits; Linux servers and Linux test runs need them (a fake without +x
# is skipped by PATH lookup and the REAL tool runs instead; Drive D-150).
#
# Run at commit time, after the files are tracked (git add):  ops/ci/set-exec-bits.sh
# Idempotent: files already mode 100755 are skipped.
#   --dry-run  print what would change
#   --check    change nothing; list the files that need +x and exit 1 when there are any (used in CI)
set -euo pipefail

DRY=0
CHECK=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --check) CHECK=1 ;;
    -h | --help)
      echo "Usage: ops/ci/set-exec-bits.sh [--dry-run | --check]"
      echo "Runs 'git update-index --chmod=+x' on every tracked *.sh, .githooks/pre-commit and test fakes."
      echo "--check changes nothing and exits 1 when any file still needs the executable bit."
      exit 0 ;;
    *) echo "unknown argument: $a" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

changed=0
# "git ls-files -s" prints: <mode> <object> <stage>\t<path>
while IFS=$'\t' read -r meta path; do
  mode="${meta%% *}"
  case "$path" in
    *.sh | .githooks/pre-commit) ;;
    */tests/fakes/*.py | */tests/fakes/__pycache__/*) continue ;;
    */tests/fakes/* | */tests/fake-*) ;;
    *) continue ;;
  esac
  [[ "$mode" == "100755" ]] && continue
  changed=$((changed + 1))
  if (( CHECK )); then
    echo "needs +x: $path"
  elif (( DRY )); then
    echo "[dry-run] git update-index --chmod=+x $path"
  else
    git update-index --chmod=+x -- "$path"
    echo "chmod +x: $path"
  fi
done < <(git ls-files -s)

echo "files needing +x: $changed"
if (( CHECK && changed > 0 )); then exit 1; fi
true
