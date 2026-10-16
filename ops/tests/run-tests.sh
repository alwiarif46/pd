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
        FAKE_MIGRATIONS FAKE_ORGS FAKE_ACTIVE BORG_PASSPHRASE PD_OS_RELEASE PD_CLOUD_BOOT_FINISHED FAKE_OLD_VOLUMES FAKE_CONTAINERS_api \
        FAKE_CONTAINERS_worker FAKE_PGDUMP_OUT FAKE_PGDUMP_EXIT FAKE_BORG_CC_LEAVE FAKE_BORG_LIST FAKE_REMOTE_MARKER FAKE_CAT_EXIT PD_MACHINE_ID_FILE
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
  # the fake repository starts with one good hourly archive
  seed_archive pd-2026-10-16T01:00:00
  printf 'thismachine0000000000000000000001\n' >"$S/machine-id"; export PD_MACHINE_ID_FILE="$S/machine-id"
}
# seed_archive NAME [CONTENT]: put an archive into the fake borg's store (default content: a valid fake pg_dump)
seed_archive() {
  local st="$S/state/borg-archives"
  mkdir -p "$st"
  printf '%b' "${2-PGDMP seeded dump\nPGDMP-END\n}" >"$st/${1//:/_}"
  printf '%s\n' "$1" >>"$st/.order"
}
archives() { cat "$S/state/borg-archives/.order" 2>/dev/null; }
ARCH_RE='pd-[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}'
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
grep -qE "borg create --compression zstd --content-from-command --stdin-name pd.dump ::$ARCH_RE -- docker compose .* pg_dump -U pd_owner -d pd -Fc" <<<"$out" \
  && ok "backup plan: borg create --content-from-command runs pg_dump -Fc itself (no pipe that borg would commit on failure)" || bad "borg create" "$out"
grep -q "pg_restore --file=/dev/null" <<<"$out" && ok "backup plan validates the new archive (pg_restore --file=/dev/null)" || bad "backup validate plan" "$out"
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

# the PD_SKIP_* test switches are ignored when the process really runs as root (bash $EUID; the fake id cannot fake it)
backup_env bk-rootskip
out="$(PD_SKIP_OWNER_CHECK=1 PD_SKIP_MODE_CHECK=1 bash -c 'source infra/lib/ops-common.sh; source ops/lib/backup-common.sh; bk_real_uid() { printf 0; }; bk_check_pass; echo PASSED' 2>&1)"; rc=$?
[[ $rc != 0 ]] && ! grep -q PASSED <<<"$out" && grep -q "is ignored: running as root" <<<"$out" && grep -qE "must be (root|0400)" <<<"$out" \
  && ok "as root, PD_SKIP_OWNER_CHECK / PD_SKIP_MODE_CHECK are ignored and borg.pass is checked" || bad "skip switches honoured as root" "rc=$rc $out"
out="$(PD_SKIP_OWNER_CHECK=1 PD_SKIP_MODE_CHECK=1 bash -c 'source infra/lib/ops-common.sh; source ops/lib/backup-common.sh; bk_check_pass; echo PASSED' 2>&1)"; rc=$?
[[ "$EUID" != 0 ]] && { [[ $rc == 0 ]] && grep -q PASSED <<<"$out" && ok "unprivileged test runs may still skip the owner/mode checks" || bad "skip switches broken for tests" "rc=$rc $out"; }
grep -q 'id -u' ops/lib/backup-common.sh && bad "backup-common.sh decides root-ness with id -u (fakeable)" || ok "backup-common.sh uses bash \$EUID, not id -u, for the skip switches"

backup_env bk-real
out="$(bash infra/scripts/backup.sh 2>&1)"; rc=$?
[[ $rc == 0 ]] && ok "backup.sh real run against the fakes exits 0" || bad "backup real run" "rc=$rc $(tail -5 <<<"$out")"
grep -q "^docker compose --env-file $S/project/.env -f $S/project/infra/docker-compose.yml exec -T postgres pg_dump -U pd_owner -d pd -Fc" "$FAKE_CALLS" \
  && grep -qE "^borg create --compression zstd --content-from-command --stdin-name pd.dump ::$ARCH_RE -- docker compose " "$FAKE_CALLS" && ok "backup ran pg_dump through borg create --content-from-command with a dated UTC archive name" || bad "backup calls" "$(cat "$FAKE_CALLS")"
[[ "$(archives | grep -cE "^$ARCH_RE$")" == 2 ]] && grep -q "^docker-validate-bytes [1-9]" "$FAKE_CALLS" && ok "the new archive is in the repository and was validated through pg_restore --file=/dev/null" || bad "new archive / validation" "$(archives) $(cat "$FAKE_CALLS")"
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
[[ $rc == 0 ]] && ! grep -q '^rclone' "$FAKE_CALLS" && grep -qE "^borg create .*::$ARCH_RE-pre-restore -- " "$FAKE_CALLS" && ok "--no-offsite skips rclone; --tag adds the suffix" || bad "no-offsite/tag" "$(cat "$FAKE_CALLS")"

# A failed pg_dump must leave NO archive behind (finding: with `pg_dump | borg create -` borg commits the empty or
# truncated stream and exits 0; prune could then keep only empty archives and the off-site sync would copy them).
backup_env bk-pgfail
out="$(FAKE_PGDUMP_OUT='PGDMP trunc' FAKE_PGDUMP_EXIT=3 bash infra/scripts/backup.sh 2>&1)"; rc=$?
[[ $rc != 0 ]] && ! grep -q '^borg prune' "$FAKE_CALLS" && ! grep -q '^rclone' "$FAKE_CALLS" && ok "a failing pg_dump fails the backup: no prune, no off-site copy" || bad "pg_dump failure" "rc=$rc $(cat "$FAKE_CALLS")"
[[ "$(archives)" == pd-2026-10-16T01:00:00 ]] && ok "a failing pg_dump leaves no archive in the repository (only the old good one)" || bad "archive left behind after a failed pg_dump" "$(archives)"
backup_env bk-pgfail-leave
out="$(FAKE_PGDUMP_EXIT=3 FAKE_BORG_CC_LEAVE=1 bash infra/scripts/backup.sh 2>&1)"; rc=$?
[[ $rc != 0 && "$(archives)" == pd-2026-10-16T01:00:00 ]] && grep -qE "^borg delete ::$ARCH_RE.checkpoint" "$FAKE_CALLS" && ! grep -q '^borg prune' "$FAKE_CALLS" \
  && ok "a .checkpoint borg leaves after a failed pg_dump is deleted before anything else runs" || bad "checkpoint left" "rc=$rc $(archives)"
backup_env bk-pgbad
out="$(FAKE_PGDUMP_OUT='' bash infra/scripts/backup.sh 2>&1)"; rc=$?
[[ $rc != 0 && "$(archives)" == pd-2026-10-16T01:00:00 ]] && grep -q "not a readable pg_dump" <<<"$out" && ! grep -q '^borg prune' "$FAKE_CALLS" && ! grep -q '^rclone' "$FAKE_CALLS" \
  && ok "an archive that pg_restore cannot read (pg_dump exited 0 with nothing) is deleted; no prune, no off-site copy" || bad "bad archive kept" "rc=$rc $(archives) $out"
backup_env bk-dup
# every name of the next two minutes "exists" (this machine can be slow to start the script)
now_s="$(date -u +%s)"
taken="$(archives; for i in $(seq 0 120); do date -u -d "@$((now_s + i))" +pd-%Y-%m-%dT%H:%M:%S; done)"
out="$(FAKE_BORG_LIST="$taken" bash infra/scripts/backup.sh 2>&1)"; rc=$?
[[ $rc != 0 ]] && grep -q "already exists" <<<"$out" && ! grep -q '^borg delete' "$FAKE_CALLS" && ok "an existing archive name is never reused (and never deleted by the clean-up)" || bad "name reuse" "rc=$rc $out"
# the pipe form must not come back
! grep -vE '^\s*#' infra/scripts/backup.sh | grep -qE 'pg_dump[^|]*\|[[:space:]]*borg create|borg create .* -$' && ok "backup.sh has no 'pg_dump | borg create -' pipe" || bad "pipe form in backup.sh"

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
lnol() { grep -nE -- "$1" "$FAKE_CALLS" | tail -1 | cut -d: -f1; }
l_val="$(lno 'exec -T postgres pg_restore --file=/dev/null')"; l_safe="$(lno '^borg create')"; l_stop="$(lno 'stop api worker')"; l_drop="$(lno 'DROP DATABASE')"; l_roles="$(lno 'CREATE ROLE pd_app')"
l_ext="$(lnol '^borg extract --stdout ::pd-2026-10-16T01:00:00 ')"; l_pgr="$(lno 'exec -T postgres pg_restore -U')"; l_start="$(lno 'start api worker')"
[[ -n "$l_val" && -n "$l_safe" && -n "$l_ext" && -n "$l_pgr" && -n "$l_start" ]] && (( l_val < l_safe && l_safe < l_stop && l_stop < l_drop && l_drop < l_roles && l_roles < l_ext && l_roles < l_pgr && l_ext < l_start && l_pgr < l_start )) \
  && ok "restore order: validate, safety backup, stop api/worker, drop+create, roles, extract|pg_restore, start" || bad "restore order" "val=$l_val safe=$l_safe stop=$l_stop drop=$l_drop roles=$l_roles ext=$l_ext pgr=$l_pgr start=$l_start"
grep -q "pg_restore -U pd_owner -d pd --exit-on-error --single-transaction" "$FAKE_CALLS" && grep -q "^borg extract --stdout ::pd-2026-10-16T01:00:00 pd.dump" "$FAKE_CALLS" && ok "restore streams borg extract --stdout into pg_restore --exit-on-error --single-transaction" || bad "restore pipe" "$(cat "$FAKE_CALLS")"
grep -q "DROP DATABASE IF EXISTS pd WITH (FORCE)" "$FAKE_CALLS" && grep -q "CREATE DATABASE pd OWNER pd_owner" "$FAKE_CALLS" && grep -q "CREATE ROLE pd_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE" "$FAKE_CALLS" \
  && grep -q "CREATE ROLE pd_system NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE" "$FAKE_CALLS" && ok "restore drops and recreates the database and creates the roles with migration 0001's attributes" || bad "restore sql"
grep -q "pre-restore" "$FAKE_CALLS" && ok "the safety backup is tagged pre-restore" || bad "safety tag"
# "latest" never picks a pre-restore safety copy or a checkpoint, even when it is newer
backup_env rs-skip
seed_archive pd-2026-10-16T05:00:00-pre-restore
seed_archive pd-2026-10-16T06:00:00.checkpoint
seed_archive pd-2026-10-16T02:00:00
out="$(bash infra/scripts/restore.sh --archive latest --confirm --no-safety-backup 2>&1)"; rc=$?
[[ $rc == 0 ]] && grep -q "^borg extract --stdout ::pd-2026-10-16T02:00:00 pd.dump" "$FAKE_CALLS" && ! grep -qE "^borg extract .*(pre-restore|checkpoint)" "$FAKE_CALLS" \
  && ok "restore latest skips *-pre-restore and .checkpoint archives (picks pd-2026-10-16T02:00:00)" || bad "latest picked a safety copy" "rc=$rc $(grep '^borg extract' "$FAKE_CALLS")"
# an invalid archive is refused BEFORE anything is dropped or stopped
for bad_content in '' 'PGDMP truncated dump with no end' 'not a dump at all'; do
  backup_env rs-invalid
  seed_archive pd-2026-10-16T03:00:00 "$bad_content"
  out="$(bash infra/scripts/restore.sh --archive latest --confirm 2>&1)"; rc=$?
  if [[ $rc != 0 ]] && grep -q "not a complete, readable pg_dump" <<<"$out" && grep -q "live database was NOT touched" <<<"$out" \
     && ! grep -qE 'DROP DATABASE|stop api worker|pg_restore -U|^borg create' "$FAKE_CALLS"; then
    ok "restore refuses an invalid archive ('${bad_content:-empty}') before the safety backup, stop or DROP"
  else
    bad "restore went ahead with an invalid archive ('${bad_content:-empty}')" "rc=$rc $(cat "$FAKE_CALLS")"
  fi
done
backup_env rs-missing
out="$(bash infra/scripts/restore.sh --archive pd-2020-01-01T00:00:00 --confirm 2>&1)"; rc=$?
[[ $rc != 0 ]] && ! grep -qE 'DROP DATABASE|stop api worker' "$FAKE_CALLS" && ok "restore of an archive that does not exist changes nothing" || bad "missing archive" "rc=$rc $(cat "$FAKE_CALLS")"
backup_env rs-empty
rm -rf "$S/state/borg-archives"
out="$(bash infra/scripts/restore.sh --archive latest --confirm 2>&1)"; rc=$?
[[ $rc != 0 ]] && grep -q "holds no regular archive" <<<"$out" && ! grep -q 'DROP DATABASE' "$FAKE_CALLS" && ok "restore latest on an empty repository refuses" || bad "empty repo" "rc=$rc $out"
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

# ------------------------------------------------------------------ deploy.sh (bugs 9-11; compose data placement)
# deploy_env: a sandbox with a copy of the libs, providers, tenant file and compose file as PD_PROJECT_DIR
deploy_env() {
  setup "$1"
  mkdir -p "$S/project/infra" "$S/project/config"
  cp -R "$REPO/infra/lib" "$REPO/infra/providers" "$S/project/infra/"
  cp "$REPO/infra/docker-compose.yml" "$S/project/infra/"
  cp "$REPO/config/tenant.toml" "$S/project/config/"
  mkdir -p "$S/project/.git"
  printf 'POSTGRES_PASSWORD=x\n' >"$S/project/.env"
}
subprocessor_set() { sed -i 's/^subprocessor   = ""/subprocessor   = "Contabo GmbH"/' "$S/project/config/tenant.toml"; }
compose_calls() { grep -c '^docker compose' "$FAKE_CALLS" || true; }

deploy_env dp-nomount
subprocessor_set
out="$(FAKE_MOUNT_PDDATA= bash infra/scripts/deploy.sh 2>&1)"; rc=$?
[[ $rc != 0 ]] && grep -q "is not mounted from /dev/mapper/pddata" <<<"$out" && [[ "$(compose_calls)" == 0 ]] && ok "deploy refuses when /mnt/pddata is not the encrypted mapper (nothing built or started)" || bad "data mount guard" "rc=$rc $out"
out="$(FAKE_MOUNT_PDBACKUP=/dev/sdb1 bash infra/scripts/deploy.sh 2>&1)"; rc=$?
[[ $rc != 0 ]] && grep -q "is not mounted from /dev/mapper/pdbackup" <<<"$out" && [[ "$(compose_calls)" == 0 ]] && ok "deploy refuses when /mnt/pdbackup is another device" || bad "backup mount guard" "rc=$rc $out"

deploy_env dp-oldvol
subprocessor_set
out="$(FAKE_OLD_VOLUME=1 bash infra/scripts/deploy.sh 2>&1)"; rc=$?
[[ $rc != 0 ]] && grep -q "infra_postgres_data" <<<"$out" && [[ "$(compose_calls)" == 0 ]] && ok "deploy refuses while the old named volume infra_postgres_data exists" || bad "old volume guard" "rc=$rc $out"

deploy_env dp-nosub
out="$(bash infra/scripts/deploy.sh 2>&1)"; rc=$?
[[ $rc != 0 ]] && grep -q "subprocessor" <<<"$out" && [[ "$(compose_calls)" == 0 ]] && ok "deploy refuses an empty hosting subprocessor (ssh adapter without [infra] subprocessor)" || bad "subprocessor guard" "rc=$rc $out"

deploy_env dp-run
subprocessor_set
out="$(bash infra/scripts/deploy.sh 2>&1)"; rc=$?
[[ $rc == 0 ]] && ok "deploy.sh real run against the fakes exits 0" || bad "deploy run" "rc=$rc $(tail -5 <<<"$out")"
lno() { grep -nE -- "$1" "$FAKE_CALLS" | head -1 | cut -d: -f1; }
l_build="$(lno ' build( |$)')"; l_db="$(lno 'up -d postgres redis')"; l_mig="$(lno 'run --rm -T migrate')"; l_up="$(lno 'up -d --remove-orphans')"
[[ -n "$l_build" && -n "$l_up" ]] && (( l_build < l_db && l_db < l_mig && l_mig < l_up )) && ok "deploy order: build, database, migrations, then restart the services" || bad "deploy order" "build=$l_build db=$l_db mig=$l_mig up=$l_up"
grep -q "^docker compose --env-file $S/project/.env -f $S/project/infra/docker-compose.yml up -d postgres redis" "$FAKE_CALLS" && ok "deploy passes --env-file and -f explicitly" || bad "compose flags"
grep -q "^env .*PD_HOSTING_SUBPROCESSOR=Contabo GmbH PD_BACKUP_SUBPROCESSOR=Backblaze, Inc. (encrypted off-site backups) PD_DATA_ROOT=$S/pddata" "$FAKE_CALLS.env" && ok "deploy exports the hosting and backup subprocessors and the data root to compose" || bad "subprocessor env" "$(tail -2 "$FAKE_CALLS.env")"
[[ -d "$S/pddata/files" && -d "$S/pddata/postgres" && -d "$S/pddata/redis" ]] && grep -q "^chown 1000:1000 $S/pddata/files" "$FAKE_CALLS" && ok "deploy creates files/, postgres/, redis/ on the data volume (files owned by 1000:1000)" || bad "data dirs" "$(ls "$S/pddata")"
! grep -vE '^\s*#' infra/scripts/deploy.sh | grep -qE '/data/(files|backups)' && ok "deploy.sh no longer uses /data/files or /data/backups" || bad "old /data paths"
grep -q "^docker compose .* build" "$FAKE_CALLS" && ! grep -q "^docker compose .* pull" "$FAKE_CALLS" && ok "without --pull-tag the images are built" || bad "build vs pull"

deploy_env dp-pull
subprocessor_set
out="$(bash infra/scripts/deploy.sh --pull-tag abc1234 2>&1)"; rc=$?
[[ $rc == 0 ]] && grep -q "^docker compose .* pull web api worker" "$FAKE_CALLS" && ! grep -q "^docker compose .* build" "$FAKE_CALLS" && grep -q "PD_IMAGE_PREFIX=ghcr.io/alwiarif46/pd- PD_IMAGE_TAG=abc1234" "$FAKE_CALLS.env" \
  && ok "--pull-tag uses compose pull and sets PD_IMAGE_PREFIX / PD_IMAGE_TAG" || bad "pull-tag" "rc=$rc $(cat "$FAKE_CALLS")"
out="$(bash infra/scripts/deploy.sh --ref v1.2.3 2>&1)"
grep -q "^git checkout v1.2.3" "$FAKE_CALLS" && ok "--ref selects the git ref" || bad "--ref"

# --ci: the request arrives in SSH_ORIGINAL_COMMAND and is parsed strictly
deploy_env dp-ci
subprocessor_set
out="$(SSH_ORIGINAL_COMMAND='ref=master tag=abc1234' bash infra/scripts/deploy.sh --ci 2>&1)"; rc=$?
[[ $rc == 0 ]] && grep -q "^git checkout master" "$FAKE_CALLS" && grep -q "PD_IMAGE_TAG=abc1234" "$FAKE_CALLS.env" && ok "--ci accepts 'ref=master tag=abc1234' (deploys that ref with that image tag)" || bad "ci accept" "rc=$rc $out"
for bad_req in 'ref=master;id' 'ref=$(x)' '' 'ref=master tag=zzz' 'ref=master tag=abc1234 extra' 'ref=-x' 'ref=a..b' 'ref=master&&id' 'tag=abc1234'; do
  deploy_env dp-ci-bad
  subprocessor_set
  out="$(SSH_ORIGINAL_COMMAND="$bad_req" bash infra/scripts/deploy.sh --ci 2>&1)"; rc=$?
  if [[ $rc == 2 && ! -s "$FAKE_CALLS" ]]; then ok "--ci refuses '$bad_req' with exit 2 and runs nothing"; else bad "--ci accepted or ran for '$bad_req'" "rc=$rc calls=$(cat "$FAKE_CALLS")"; fi
done
deploy_env dp-ci-unset
out="$(env -u SSH_ORIGINAL_COMMAND bash infra/scripts/deploy.sh --ci 2>&1)"; rc=$?
[[ $rc == 2 && ! -s "$FAKE_CALLS" ]] && ok "--ci without SSH_ORIGINAL_COMMAND is refused (exit 2)" || bad "--ci unset" "rc=$rc"

deploy_env dp-dry
out="$(bash infra/scripts/deploy.sh --dry-run 2>&1)"; rc=$?
[[ $rc == 0 ]] && ! grep -qE '^(docker compose|git (fetch|checkout|pull|clone)|chown)' "$FAKE_CALLS" && ok "deploy.sh --dry-run exits 0 and changes nothing (only read-only probes: findmnt, docker volume inspect)" || bad "deploy dry-run" "rc=$rc $(cat "$FAKE_CALLS")"

# docker-compose.yml (bugs 10-11)
yml="$(cat infra/docker-compose.yml)"
! grep -qE '^version:' infra/docker-compose.yml && ok "compose: no obsolete version key" || bad "compose version key"
grep -q '${PD_DATA_ROOT:-/mnt/pddata}/postgres:/var/lib/postgresql/data' <<<"$yml" && grep -q '${PD_DATA_ROOT:-/mnt/pddata}/redis:/data' <<<"$yml" && ok "compose: postgres and redis data on /mnt/pddata" || bad "compose data paths"
[[ "$(grep -c '${PD_DATA_ROOT:-/mnt/pddata}/files:/data/files' <<<"$yml")" == 2 && "$(grep -c 'DATA_DIR=/data/files' <<<"$yml")" == 2 ]] && ok "compose: api and worker share the files volume with DATA_DIR=/data/files" || bad "compose files volume"
! grep -qE '^  (postgres_data|redis_data):' infra/docker-compose.yml && grep -q '^  clamav_data:' infra/docker-compose.yml && ok "compose: the postgres/redis named volumes are gone, clamav_data stays" || bad "compose named volumes"
grep -q 'PD_HOSTING_SUBPROCESSOR=${PD_HOSTING_SUBPROCESSOR:-}' <<<"$yml" && grep -q 'PD_BACKUP_SUBPROCESSOR=${PD_BACKUP_SUBPROCESSOR:-}' <<<"$yml" && ok "compose: the api receives both subprocessor values" || bad "compose subprocessors"
[[ "$(grep -c 'image: ${PD_IMAGE_PREFIX:-pd-}' <<<"$yml")" == 5 ]] && ok "compose: five images follow PD_IMAGE_PREFIX / PD_IMAGE_TAG (defaults unchanged)" || bad "compose image variables"


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
