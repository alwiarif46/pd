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
         PD_PROJECT_DIR="$S/project" PD_SKIP_OWNER_CHECK=1 \
         FAKE_CALLS="$S/calls" FAKE_STATE="$S/state" PATH="$FAKES:$ORIG_PATH" PD_SECRETS="$S/secrets.env"
  unset PD_SKIP_MODE_CHECK PD_TENANT FAKE_MOUNT_PDBACKUP FAKE_MOUNT_PDDATA FAKE_OLD_VOLUME FAKE_REMOTE_COUNT FAKE_LSF FAKE_BORG_EXIT FAKE_COMPOSE_EXIT \
        FAKE_MIGRATIONS FAKE_ORGS FAKE_ACTIVE BORG_PASSPHRASE PD_OS_RELEASE PD_CLOUD_BOOT_FINISHED
  : >"$FAKE_CALLS"
  : >"$S/secrets.env"
}

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

# ------------------------------------------------------------------ backup.sh (bugs 4, 5)
# backup_env: a sandbox with a valid borg.pass and a Borg repository directory
backup_env() {
  setup "$1"
  printf 'borg-secret-pass-123\n' >"$S/etc/borg.pass"; chmod 0400 "$S/etc/borg.pass"
  echo "borg repo" >"$S/pdbackup/borg/config"; echo data >"$S/pdbackup/borg/data-1"
  # rclone state for the off-site step
  sed -e 's|{{BUCKET}}|shaavir-pd-backup-us|' -e 's|{{CRYPT_PREFIX}}|shaavir-pd|' "$REPO/ops/backup/rclone.conf.template" >"$S/etc/rclone.conf"
  printf 'RCLONE_CONFIG_B2_ACCOUNT=%s\nRCLONE_CONFIG_B2_KEY=%s\nRCLONE_CONFIG_B2CRYPT_PASSWORD=obsc-AAAA\nRCLONE_CONFIG_B2CRYPT_PASSWORD2=obsc-BBBB\n' "$SECRET_ACCT" "$SECRET_KEY" >"$S/etc/rclone.env"
  chmod 0600 "$S/etc/rclone.env"
  if [[ "$(stat -c %a "$S/etc/borg.pass")" != 400 ]]; then export PD_SKIP_MODE_CHECK=1; else unset PD_SKIP_MODE_CHECK; fi
  : >"$FAKE_CALLS.env"
}
SECRET_ACCT="0012fakeaccountid0000000"
SECRET_KEY="K00SECRETAPPKEYvalue123456789"
no_secret_in() { # no_secret_in FILE... : none of the secret values appear
  local f v
  for f in "$@"; do [[ -f "$f" ]] || continue
    for v in "$SECRET_ACCT" "$SECRET_KEY" borg-secret-pass-123; do
      grep -qF -- "$v" "$f" && { echo "secret '$v' found in $f"; return 1; }
    done
  done
  return 0
}

backup_env bk-dry
out="$(bash infra/scripts/backup.sh --dry-run 2>&1)"; rc=$?
[[ $rc == 0 ]] && ok "backup.sh --dry-run exits 0" || bad "backup dry-run" "rc=$rc $(tail -3 <<<"$out")"
grep -q -- "--env-file $S/project/.env -f $S/project/infra/docker-compose.yml exec -T postgres pg_dump -U pd_owner -d pd -Fc" <<<"$out" \
  && ok "backup plan passes --env-file and -f explicitly (bug 4: it used to need to run next to a compose file)" || bad "compose flags" "$out"
grep -q "borg create --compression zstd --stdin-name pd.dump" <<<"$out" && ok "backup plan: pg_dump -Fc piped into borg create --stdin-name pd.dump" || bad "borg create" "$out"
! grep -qE '^(docker|borg) ' "$FAKE_CALLS" && ok "backup --dry-run runs no docker or borg command" || bad "dry-run made calls" "$(cat "$FAKE_CALLS")"

backup_env bk-nomount
out="$(FAKE_MOUNT_PDBACKUP= bash infra/scripts/backup.sh 2>&1)"; rc=$?
[[ $rc != 0 ]] && grep -q "not mounted from /dev/mapper/pdbackup" <<<"$out" && ! grep -q '^borg create' "$FAKE_CALLS" && ok "backup refuses when /mnt/pdbackup is not the LUKS mapper (nothing written to the root disk)" || bad "mount guard" "rc=$rc $out"
out="$(FAKE_MOUNT_PDBACKUP=/dev/sda1 bash infra/scripts/backup.sh 2>&1)"; rc=$?
[[ $rc != 0 ]] && grep -q "found: '/dev/sda1'" <<<"$out" && ok "backup refuses a backup mount on another device" || bad "wrong device" "$out"

backup_env bk-pass
chmod 0644 "$S/etc/borg.pass"
if [[ "$(stat -c %a "$S/etc/borg.pass")" == 644 ]]; then
  unset PD_SKIP_MODE_CHECK
  out="$(bash infra/scripts/backup.sh 2>&1)"; rc=$?
  [[ $rc != 0 ]] && grep -q "has mode 644, must be 0400" <<<"$out" && ! grep -q '^borg create' "$FAKE_CALLS" && ok "backup refuses a borg.pass with the wrong mode" || bad "pass mode guard" "rc=$rc $out"
else
  skip "borg.pass mode guard (this file system has no POSIX modes)"
fi

backup_env bk-real
out="$(bash infra/scripts/backup.sh 2>&1)"; rc=$?
[[ $rc == 0 ]] && ok "backup.sh real run against the fakes exits 0" || bad "backup real run" "rc=$rc $(tail -5 <<<"$out")"
grep -q "^docker compose --env-file $S/project/.env -f $S/project/infra/docker-compose.yml exec -T postgres pg_dump -U pd_owner -d pd -Fc" "$FAKE_CALLS" \
  && grep -q "^borg create --compression zstd --stdin-name pd.dump ::pd-{now:%Y-%m-%dT%H:%M:%S} -" "$FAKE_CALLS" && ok "backup ran pg_dump into borg create with the dated archive name" || bad "backup calls" "$(cat "$FAKE_CALLS")"
[[ "$(cat "$S/state/borg-create-bytes" 2>/dev/null)" -gt 0 ]] && ok "the dump stream reached borg (stdin bytes > 0)" || bad "no bytes into borg"
no_secret_in "$FAKE_CALLS" "$FAKE_CALLS.env" <(printf '%s' "$out") && grep -q 'BORG_PASSCOMMAND' "$FAKE_CALLS.env" && ! grep -q 'BORG_PASSPHRASE' "$FAKE_CALLS.env" \
  && ok "the Borg passphrase is never in argv or the environment (BORG_PASSCOMMAND only)" || bad "passphrase leaked or BORG_PASSCOMMAND missing" "$(cat "$FAKE_CALLS.env")"
grep -q "^borg prune --keep-within=2d --keep-daily=30 --glob-archives pd-\*" "$FAKE_CALLS" && grep -q "^borg compact" "$FAKE_CALLS" && ok "prune uses the tenant retention, then compact" || bad "prune" "$(grep '^borg' "$FAKE_CALLS")"
grep -q "^rclone --config $S/etc/rclone.conf sync $S/pdbackup/borg b2crypt:borg --b2-hard-delete=false" "$FAKE_CALLS" && ok "off-site sync runs after the backup (rclone sync with --b2-hard-delete=false)" || bad "offsite not called" "$(grep '^rclone' "$FAKE_CALLS")"
[[ -f "$S/log/backup.log" ]] && ok "backup log written to PD_LOG_DIR" || bad "no backup.log"
[[ -z "$(find "$S/state" -name '*.dump' -o -name '*.sql*' 2>/dev/null)" ]] && ok "no plain dump file on disk" || bad "plain dump written"

backup_env bk-noff
: >"$FAKE_CALLS"
out="$(bash infra/scripts/backup.sh --no-offsite --tag pre-restore 2>&1)"; rc=$?
[[ $rc == 0 ]] && ! grep -q '^rclone' "$FAKE_CALLS" && grep -q "^borg create .*::pd-{now:%Y-%m-%dT%H:%M:%S}-pre-restore -" "$FAKE_CALLS" && ok "--no-offsite skips rclone; --tag adds the suffix" || bad "no-offsite/tag" "$(cat "$FAKE_CALLS")"

backup_env bk-pgfail
out="$(FAKE_COMPOSE_EXIT=3 FAKE_BORG_EXIT=0 bash infra/scripts/backup.sh 2>&1)"; rc=$?
# the fake compose prints nothing and exits 3: pipefail must fail the script before prune/offsite
[[ $rc != 0 ]] && ! grep -q '^borg prune' "$FAKE_CALLS" && ! grep -q '^rclone' "$FAKE_CALLS" && ok "a failing pg_dump fails the backup (pipefail): no prune, no off-site copy" || bad "pipefail" "rc=$rc $(cat "$FAKE_CALLS")"

backup_env bk-init
rm -f "$S/pdbackup/borg/config"
out="$(bash infra/scripts/backup.sh --init 2>&1)"; rc=$?
[[ $rc == 0 ]] && grep -q "^borg init --encryption=repokey-blake2" "$FAKE_CALLS" && grep -q "^borg key export :: $S/etc/borg-key.txt" "$FAKE_CALLS" && grep -q "shred" <<<"$out" \
  && ok "--init: borg init repokey-blake2, key export to /etc/pd/borg-key.txt, vault reminder" || bad "init" "rc=$rc $out"
echo "borg repo" >"$S/pdbackup/borg/config"
out="$(bash infra/scripts/backup.sh --init 2>&1)"; rc=$?
[[ $rc != 0 ]] && ok "--init refuses an existing repository" || bad "init over a repo"

# ------------------------------------------------------------------ restore.sh (bugs 6-8)
backup_env rs-confirm
out="$(bash infra/scripts/restore.sh --archive latest 2>&1)"; rc=$?
[[ $rc != 0 ]] && grep -q -- "--confirm" <<<"$out" && ! grep -qE 'DROP DATABASE|pg_restore' "$FAKE_CALLS" && ok "restore refuses without --confirm" || bad "restore confirm guard" "rc=$rc $out"
backup_env rs-list
out="$(bash infra/scripts/restore.sh --list 2>&1)"; rc=$?
[[ $rc == 0 ]] && grep -q "pd-2026-10-16T01:00:00" <<<"$out" && ok "restore --list prints the archives" || bad "restore list" "$out"
backup_env rs-run
out="$(bash infra/scripts/restore.sh --archive latest --confirm 2>&1)"; rc=$?
[[ $rc == 0 ]] && ok "restore --archive latest --confirm exits 0 against the fakes" || bad "restore run" "rc=$rc $(tail -6 <<<"$out")"
lno() { grep -nE -- "$1" "$FAKE_CALLS" | head -1 | cut -d: -f1; }
l_safe="$(lno '^borg create')"; l_stop="$(lno 'stop api worker')"; l_drop="$(lno 'DROP DATABASE')"; l_roles="$(lno 'CREATE ROLE pd_app')"; l_ext="$(lno '^borg extract')"; l_pgr="$(lno 'exec -T postgres pg_restore')"; l_start="$(lno 'start api worker')"
[[ -n "$l_safe" && -n "$l_ext" && -n "$l_pgr" && -n "$l_start" ]] && (( l_safe < l_stop && l_stop < l_drop && l_drop < l_roles && l_roles < l_ext && l_roles < l_pgr && l_ext < l_start && l_pgr < l_start ))   && ok "restore order: safety backup, stop api/worker, drop+create, roles, extract|pg_restore, start" || bad "restore order" "safe=$l_safe stop=$l_stop drop=$l_drop roles=$l_roles ext=$l_ext pgr=$l_pgr start=$l_start"
grep -q "pg_restore -U pd_owner -d pd --exit-on-error --single-transaction" "$FAKE_CALLS" && grep -q "^borg extract --stdout ::pd-2026-10-16T01:00:00 pd.dump" "$FAKE_CALLS" && ok "restore streams borg extract --stdout into pg_restore --exit-on-error --single-transaction" || bad "restore pipe" "$(cat "$FAKE_CALLS")"
grep -q "DROP DATABASE IF EXISTS pd WITH (FORCE)" "$FAKE_CALLS" && grep -q "CREATE DATABASE pd OWNER pd_owner" "$FAKE_CALLS" && grep -q "CREATE ROLE pd_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE" "$FAKE_CALLS" \
  && grep -q "CREATE ROLE pd_system NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE" "$FAKE_CALLS" && ok "restore drops and recreates the database and creates the roles with migration 0001's attributes" || bad "restore sql"
grep -q "pre-restore" "$FAKE_CALLS" && ok "the safety backup is tagged pre-restore" || bad "safety tag"
backup_env rs-nosafety
out="$(bash infra/scripts/restore.sh --archive pd-2026-10-16T01:00:00 --confirm --no-safety-backup 2>&1)"; rc=$?
[[ $rc == 0 ]] && ! grep -q '^borg create' "$FAKE_CALLS" && grep -q 'stop api worker' "$FAKE_CALLS" && ok "--no-safety-backup skips the safety backup" || bad "no-safety" "$(cat "$FAKE_CALLS")"
[[ -z "$(find "$S" -maxdepth 3 \( -name 'pg_restore*' -o -name '*.dump' \) 2>/dev/null)" ]] && ! grep -vE '^\s*#' infra/scripts/restore.sh | grep -q '/tmp' && ok "restore writes no decompressed copy and never touches /tmp" || bad "restore wrote a file or mentions /tmp"
backup_env rs-dry
: >"$FAKE_CALLS"
out="$(bash infra/scripts/restore.sh --archive latest --dry-run 2>&1)"; rc=$?
[[ $rc == 0 ]] && ! grep -qE '^(docker|borg)' "$FAKE_CALLS" && ok "restore --dry-run makes no docker or borg call" || bad "restore dry-run" "rc=$rc $(cat "$FAKE_CALLS")"

# ------------------------------------------------------------------ offsite-sync.sh
backup_env of-ok
out="$(bash ops/backup/offsite-sync.sh --wait-min 0 2>&1)"; rc=$?
[[ $rc == 0 ]] && ok "offsite-sync exits 0 against the fakes" || bad "offsite run" "rc=$rc $(tail -4 <<<"$out")"
grep -q "^rclone --config $S/etc/rclone.conf sync $S/pdbackup/borg b2crypt:borg --b2-hard-delete=false" "$FAKE_CALLS" && ok "rclone sync passes --b2-hard-delete=false" || bad "sync call" "$(cat "$FAKE_CALLS")"
last_sync="$(grep -n '^rclone .* sync ' "$FAKE_CALLS" | tail -1 | cut -d: -f1)"; last_copy="$(grep -n '^rclone .* copyto ' "$FAKE_CALLS" | tail -1 | cut -d: -f1)"
[[ -n "$last_copy" && -n "$last_sync" && "$last_copy" -gt "$last_sync" ]] && grep -q "copyto $S/pdbackup/pd/last-offsite-ok b2crypt:pd/last-offsite-ok" "$FAKE_CALLS" && ok "pd/last-offsite-ok is written and uploaded LAST" || bad "marker order" "$(cat "$FAKE_CALLS")"
no_secret_in "$FAKE_CALLS" <(printf '%s' "$out") && grep -q 'RCLONE_CONFIG_B2CRYPT_PASSWORD2' "$FAKE_CALLS.env" && ok "B2 and crypt keys reach rclone only through the environment, never argv or output" || bad "offsite secrets" "$(cat "$FAKE_CALLS.env")"
! grep -qE -- '--b2-hard-delete(=true| true)' "$FAKE_CALLS" && ok "no hard delete is ever requested" || bad "hard delete"

backup_env of-empty
rm -f "$S/pdbackup/borg/config" "$S/pdbackup/borg/data-1"
out="$(bash ops/backup/offsite-sync.sh --wait-min 0 2>&1)"; rc=$?
[[ $rc != 0 ]] && grep -q "missing or empty" <<<"$out" && ! grep -q ' sync ' "$FAKE_CALLS" && ok "offsite-sync refuses an empty source" || bad "empty source" "rc=$rc $out"
backup_env of-hard
printf 'hard_delete = true\n' >>"$S/etc/rclone.conf"
out="$(bash ops/backup/offsite-sync.sh --wait-min 0 2>&1)"; rc=$?
[[ $rc != 0 ]] && grep -q "hard_delete = true" <<<"$out" && ! grep -q ' sync ' "$FAKE_CALLS" && ok "offsite-sync refuses an rclone.conf with hard_delete = true" || bad "hard_delete guard" "$out"
backup_env of-remote
sed -i 's|remote = b2:shaavir-pd-backup-us/shaavir-pd|remote = b2:other-bucket/other|' "$S/etc/rclone.conf"
out="$(bash ops/backup/offsite-sync.sh --wait-min 0 2>&1)"; rc=$?
[[ $rc != 0 ]] && grep -q "tenant file says 'b2:shaavir-pd-backup-us/shaavir-pd'" <<<"$out" && ! grep -q ' sync ' "$FAKE_CALLS" && ok "offsite-sync refuses a crypt remote that is not the tenant's bucket/prefix" || bad "remote guard" "$out"
backup_env of-ratio
out="$(FAKE_REMOTE_COUNT=100 bash ops/backup/offsite-sync.sh --wait-min 0 2>&1)"; rc=$?
[[ $rc != 0 ]] && grep -q "refusing to sync" <<<"$out" && ! grep -q ' sync ' "$FAKE_CALLS" && ok "offsite-sync refuses when the source holds < 50% of the files B2 holds" || bad "min-ratio guard" "rc=$rc $out"
backup_env of-lock
mkdir -p "$S/pdbackup/borg/lock.exclusive"
out="$(bash ops/backup/offsite-sync.sh --wait-min 0 2>&1)"; rc=$?
[[ $rc != 0 ]] && grep -q "still locked" <<<"$out" && ! grep -q ' sync ' "$FAKE_CALLS" && ok "offsite-sync refuses while Borg holds a lock" || bad "lock guard" "$out"
backup_env of-nomount
out="$(FAKE_MOUNT_PDBACKUP= bash ops/backup/offsite-sync.sh --wait-min 0 2>&1)"; rc=$?
[[ $rc != 0 ]] && grep -q "not mounted from /dev/mapper/pdbackup" <<<"$out" && ! grep -q ' sync ' "$FAKE_CALLS" && ok "offsite-sync refuses an unmounted backup volume" || bad "mount guard offsite" "$out"
backup_env of-dry
out="$(bash ops/backup/offsite-sync.sh --dry-run 2>&1)"; rc=$?
[[ $rc == 0 ]] && ! grep -qE '^rclone' "$FAKE_CALLS" && ok "offsite-sync --dry-run exits 0 and calls nothing" || bad "offsite dry-run" "rc=$rc $(cat "$FAKE_CALLS")"

# ------------------------------------------------------------------ rclone-setup.sh / install.sh (dry-run)
setup rcs
out="$(bash ops/backup/rclone-setup.sh --dry-run 2>&1)"; rc=$?
[[ $rc == 0 ]] && grep -q "b2:shaavir-pd-backup-us/shaavir-pd" <<<"$out" && grep -q "rclone obscure -" <<<"$out" && ok "rclone-setup --dry-run: remote from the tenant, crypt passwords obscured over stdin" || bad "rclone-setup dry" "$out"
out="$(PD_UNIT_DIR="$S/units" bash ops/install.sh --dry-run 2>&1)"; rc=$?
[[ $rc == 0 ]] && grep -q "OnCalendar=hourly" <<<"$out" && grep -q "Persistent=true" <<<"$out" && grep -q "backup.sh" <<<"$out" && ok "install.sh --dry-run renders an hourly persistent pd-backup timer" || bad "install dry" "$out"

# ------------------------------------------------------------------ restore-drill/drill.sh
JOURNAL_N="$("$PY" -c 'import json,sys; print(len(json.load(open(sys.argv[1], encoding="utf-8"))["entries"]))' "$(np "$REPO/packages/core/src/db/migrations/meta/_journal.json")")"
drill_env() {
  backup_env "$1"
  printf 'RCLONE_CONFIG_B2_ACCOUNT=restoreacct\nRCLONE_CONFIG_B2_KEY=%s\nRCLONE_CONFIG_B2CRYPT_PASSWORD=obsc-AAAA\nRCLONE_CONFIG_B2CRYPT_PASSWORD2=obsc-BBBB\n' "$SECRET_KEY" >"$S/restore.env"
}
drill_env dr-plan
out="$(bash ops/restore-drill/drill.sh plan 2>&1)"; rc=$?
[[ $rc == 0 ]] && grep -q "network none" <<<"$out" && grep -q "4 h RTO" <<<"$out" && ! grep -qE '^(docker|borg|rclone)' "$FAKE_CALLS" && ok "drill plan prints the steps and makes no docker/borg/rclone call" || bad "drill plan" "rc=$rc $out"
drill_env dr-run
out="$(FAKE_MIGRATIONS=$JOURNAL_N bash ops/restore-drill/drill.sh run --repo "$S/pdbackup/borg" --borg-pass "$S/etc/borg.pass" 2>&1)"; rc=$?
[[ $rc == 0 ]] && ok "drill run against the fakes exits 0 when migrations match the journal ($JOURNAL_N)" || bad "drill run" "rc=$rc $(tail -6 <<<"$out")"
grep -qE '^docker run -d --rm --name pd-drill-[0-9]+ --network none -e POSTGRES_USER=pd_owner -e POSTGRES_PASSWORD postgres:16-alpine' "$FAKE_CALLS" && ok "drill container: --network none, throwaway, password passed through the environment (not in argv)" || bad "drill docker run" "$(grep '^docker run' "$FAKE_CALLS")"
grep -q "pg_restore -U pd_owner -d pd --exit-on-error --single-transaction" "$FAKE_CALLS" && grep -q "^borg extract --stdout ::pd-2026-10-16T01:00:00 pd.dump" "$FAKE_CALLS" && ok "drill restores the newest archive through pg_restore --single-transaction" || bad "drill restore" "$(cat "$FAKE_CALLS")"
grep -q "^docker rm -f pd-drill-" "$FAKE_CALLS" && ok "drill removes its container on exit" || bad "drill container not removed"
grep -q "migrations applied: $JOURNAL_N, journal entries: $JOURNAL_N" <<<"$out" && grep -q "organizations     : 2" <<<"$out" && grep -q "STATE.md:" <<<"$out" && ok "drill compares the migration count with _journal.json, prints the organizations count and a STATE.md line" || bad "drill verify" "$out"
drill_env dr-mismatch
out="$(FAKE_MIGRATIONS=1 bash ops/restore-drill/drill.sh run --repo "$S/pdbackup/borg" --borg-pass "$S/etc/borg.pass" 2>&1)"; rc=$?
[[ $rc != 0 ]] && grep -q "FAILED" <<<"$out" && grep -q "^docker rm -f pd-drill-" "$FAKE_CALLS" && ok "drill fails when the migration count differs from the journal (container still removed)" || bad "drill mismatch" "rc=$rc $out"
drill_env dr-fail
out="$(FAKE_PGRESTORE_EXIT=1 FAKE_MIGRATIONS=$JOURNAL_N bash ops/restore-drill/drill.sh run --repo "$S/pdbackup/borg" --borg-pass "$S/etc/borg.pass" 2>&1)"; rc=$?
[[ $rc != 0 ]] && grep -q "^docker rm -f pd-drill-" "$FAKE_CALLS" && ok "a failing pg_restore still removes the container (EXIT trap)" || bad "drill trap" "rc=$rc $(cat "$FAKE_CALLS")"
drill_env dr-offsite
out="$(FAKE_MIGRATIONS=$JOURNAL_N FAKE_COPY_DEST_FILES=1 bash ops/restore-drill/drill.sh run --from-offsite --rclone-env "$S/restore.env" --borg-pass "$S/etc/borg.pass" 2>&1)"; rc=$?
grep -q "^rclone --config .* copy b2crypt:borg " "$FAKE_CALLS" && ! grep -qF -- "$SECRET_KEY" "$FAKE_CALLS" && ! grep -qF -- "$SECRET_KEY" <<<"$out" && ok "drill --from-offsite pulls b2crypt:borg with the key only in the environment" || bad "drill offsite" "rc=$rc $(grep '^rclone' "$FAKE_CALLS")"

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
