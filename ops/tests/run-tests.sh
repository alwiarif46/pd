#!/usr/bin/env bash
# ops/tests/run-tests.sh - offline tests for PD's server-side scripts: setup-server.sh, deploy-user.sh,
# deploy.sh, backup.sh, restore.sh, ops/backup/*, ops/restore-drill/drill.sh.
#
# Runs the REAL scripts with fakes first on PATH (ops/tests/fakes: docker, borg, rclone, findmnt, mountpoint,
# systemctl, id, curl, git, ssh, install, chown). Every path the scripts use is redirected into a temp dir
# (PD_ETC, PD_BACKUP_MOUNT, PD_DATA_MOUNT, PD_LOG_DIR, PD_PROJECT_DIR, ...). No network, no root, no real Docker,
# no real Borg or rclone, nothing outside the temp dir.
#
# Usage: bash ops/tests/run-tests.sh          exit 0 = all pass
# On Windows run it from Git Bash (the bash in System32 is WSL).
# shellcheck disable=SC2015  # test harness: A && ok || bad is intentional
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"
harness_init "$(cd "$HERE/../.." && pwd)"
FAKES="$REPO/ops/tests/fakes"
guard_fakes
guard_no_luksformat

np() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }  # native path for python.exe

# setup NAME: a fresh sandbox; every path the scripts use points into it.
setup() {
  S="$TMP/$1"; rm -rf "$S"; mkdir -p "$S"/{etc,pdbackup/borg,pddata/files,log,state,project/infra/scripts}
  export PD_ETC="$S/etc" PD_BACKUP_MOUNT="$S/pdbackup" PD_DATA_MOUNT="$S/pddata" PD_LOG_DIR="$S/log" PD_STATE_DIR="$S/state" \
         PD_PROJECT_DIR="$S/project" PD_SKIP_PERM_CHECK=1 \
         FAKE_CALLS="$S/calls" FAKE_STATE="$S/state" PATH="$FAKES:$ORIG_PATH" PD_SECRETS="$S/secrets.env"
  unset PD_TENANT FAKE_MOUNT_PDBACKUP FAKE_MOUNT_PDDATA FAKE_OLD_VOLUME FAKE_REMOTE_COUNT FAKE_LSF FAKE_BORG_EXIT FAKE_COMPOSE_EXIT \
        FAKE_MIGRATIONS FAKE_ORGS FAKE_ACTIVE BORG_PASSPHRASE PD_OS_RELEASE PD_CLOUD_BOOT_FINISHED
  : >"$FAKE_CALLS"
  : >"$S/secrets.env"
}
# @@HELPERS (commit 7)

# ------------------------------------------------------------------ setup-server.sh (bugs 1-3)
setup setup-server
out="$(bash infra/scripts/setup-server.sh --dry-run 2>&1)"; rc=$?
[[ $rc == 0 ]] && ok "setup-server.sh --dry-run exits 0" || bad "setup-server dry-run" "rc=$rc $(tail -3 <<<"$out")"
grep -q 'install-docker.sh' <<<"$out" && ok "setup-server plan calls install-docker.sh (Docker Engine + compose plugin)" || bad "install-docker not in plan" "$out"
! grep -qiE 'docker-compose |docker\.io|pnpm|npm install|ufw (allow|enable|default)|certbot|/data/(files|backups)' <<<"$out" \
  && ok "setup-server plan has no docker-compose v1, docker.io, pnpm/npm, ufw rules, certbot or /data" || bad "setup-server plan names a removed step" "$(grep -iE 'docker-compose |docker.io|pnpm|npm|ufw|certbot|/data/' <<<"$out")"
code="$(grep -vE '^\s*(#|echo )' infra/scripts/setup-server.sh)"
! grep -qE 'docker\.io|docker-compose|npm install|pnpm|ufw (allow|enable|default)|/data/' <<<"$code"   && ok "setup-server.sh code no longer installs docker.io / docker-compose / pnpm, configures ufw or creates /data" || bad "setup-server.sh source still has a removed step" "$(grep -nE 'docker.io|docker-compose|npm|pnpm|ufw|/data/' <<<"$code")"
grep -q 'set -euo pipefail' infra/scripts/setup-server.sh && ok "setup-server.sh runs under set -euo pipefail" || bad "setup-server.sh without pipefail"
# a real (non-dry) run is refused without the base system: the plan must not get as far as installing anything
out="$(PD_OS_RELEASE="$S/os-release" PD_ETC="$S/etc" PD_CLOUD_BOOT_FINISHED="$S/none" bash infra/scripts/setup-server.sh 2>&1)"; rc=$?
[[ $rc != 0 ]] && ok "setup-server.sh refuses a real run when it is not Ubuntu 24.04 / no base system" || bad "setup-server ran on a box without the base system" "$out"
printf 'ID=ubuntu\nVERSION_ID="24.04"\n' >"$S/os-release"
out="$(PD_OS_RELEASE="$S/os-release" PD_CLOUD_BOOT_FINISHED="$S/none" bash infra/scripts/setup-server.sh 2>&1)"; rc=$?
[[ $rc != 0 ]] && grep -q 'bootstrap-existing.sh' <<<"$out" && ok "setup-server.sh tells the operator to run bootstrap-existing.sh first" || bad "base-system hint" "$out"

# ------------------------------------------------------------------ deploy-user.sh
setup deploy-user
ssh-keygen -q -t ed25519 -N "" -C ci@test -f "$S/ci" >/dev/null 2>&1 || printf 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIfake ci@test\n' >"$S/ci.pub"
out="$(env -u PD_PROJECT_DIR bash infra/server/deploy-user.sh --dry-run --pubkey "$S/ci.pub" 2>&1)"; rc=$?
[[ $rc == 0 ]] && ok "deploy-user.sh --dry-run exits 0" || bad "deploy-user dry-run" "rc=$rc $(tail -3 <<<"$out")"
grep -q 'restrict,command="sudo -n /opt/pd/infra/scripts/deploy.sh --ci" ssh-ed25519' <<<"$out" && ok "deploy-user: forced command + restrict on the key" || bad "forced command" "$out"
grep -q 'pddeploy ALL=(root) NOPASSWD: /opt/pd/infra/scripts/deploy.sh --ci' <<<"$out" && grep -q 'env_keep += "SSH_ORIGINAL_COMMAND"' <<<"$out" && ok "deploy-user: sudoers allows exactly deploy.sh --ci and keeps SSH_ORIGINAL_COMMAND" || bad "sudoers" "$out"
grep -q 'visudo -cf' infra/server/deploy-user.sh && grep -q '0440' infra/server/deploy-user.sh && ok "deploy-user: sudoers is mode 0440 and checked with visudo -cf before install" || bad "visudo check"
grep -q 'AllowUsers pdadmin pddeploy' <<<"$out" && grep -q 'sshd -t' <<<"$out" && ok "deploy-user: sshd drop-in AllowUsers pdadmin pddeploy, sshd -t, reload" || bad "sshd drop-in" "$out"
grep -q 'passwd -l pddeploy' <<<"$out" && grep -q -- '--shell /bin/sh' <<<"$out" && ok "deploy-user: system user, /bin/sh, locked password" || bad "user flags"
out="$(bash infra/server/deploy-user.sh --pubkey "$S/ci.pub" 2>&1)"; rc=$?
[[ $rc != 0 ]] && grep -q -- '--confirm' <<<"$out" && ok "deploy-user refuses a real run without --confirm" || bad "no --confirm guard" "$out"
printf -- '-----BEGIN OPENSSH PRIVATE KEY-----\nx\n' >"$S/priv"  # secret-scan: allow (fake key header for a test)
out="$(bash infra/server/deploy-user.sh --dry-run --pubkey "$S/priv" 2>&1)"; rc=$?
[[ $rc != 0 ]] && ok "deploy-user refuses a private key file" || bad "private key accepted"
mkdir -p "$S/project/infra/scripts"; : >"$S/project/infra/scripts/deploy.sh"; chmod 0777 "$S/project/infra/scripts/deploy.sh" 2>/dev/null
if [[ "$(stat -c %a "$S/project/infra/scripts/deploy.sh" 2>/dev/null)" == 777 ]]; then
  out="$(bash infra/server/deploy-user.sh --dry-run --pubkey "$S/ci.pub" 2>&1)"
  grep -q 'group- or world-writable' <<<"$out" && ok "deploy-user flags a world-writable deploy.sh" || bad "writable deploy.sh not flagged" "$out"
else
  skip "world-writable deploy.sh guard (this file system has no POSIX modes)"
fi

# @@SECTION backup-restore (commit 7)
# @@SECTION drill (commit 8)
# @@SECTION deploy (commit 9)

# ------------------------------------------------------------------ static
mapfile -t SH < <(find ops infra/scripts -name '*.sh' -not -path '*/node_modules/*')
badsyntax=""
for f in "${SH[@]}"; do bash -n "$f" 2>"$TMP/syn.txt" || badsyntax+="$f: $(head -1 "$TMP/syn.txt")"$'\n'; done
[[ -z "$badsyntax" ]] && ok "bash -n on every ops/ and infra/scripts script (${#SH[@]} files)" || bad "bash -n" "$badsyntax"
if command -v shellcheck >/dev/null 2>&1; then
  if shellcheck -S warning -x -P SCRIPTDIR "${SH[@]}" >"$TMP/sc.txt" 2>&1; then ok "shellcheck clean (ops, infra/scripts)"; else bad "shellcheck" "$(head -20 "$TMP/sc.txt")"; fi
else
  skip "shellcheck not installed"
fi

summary
