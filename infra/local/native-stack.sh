#!/usr/bin/env bash
# infra/local/native-stack.sh - the local stack without Docker (E2E_STACK=native; BUILD-PLAN s3 and s8).
#
#   infra/local/native-stack.sh start     start Postgres, Redis and the three test doubles, print the env vars
#   infra/local/native-stack.sh status    one line per part; exit 0 only when all are up
#   infra/local/native-stack.sh env       print the export lines (use: eval "$(infra/local/native-stack.sh env)")
#   infra/local/native-stack.sh stop      stop what start started
#
# What runs: real Postgres 16 (no pgvector), real redis-server (appendonly yes, maxmemory-policy noeviction), and the
# doubles in packages/testing/src/doubles (mock OIDC for Zitadel, in-memory S3 for the S3 store, a clamd stand-in for
# ClamAV). The sandbox container has no native form. Run `start` again and nothing starts twice.
#
# Settings (environment):
#   PD_NATIVE_DIR           data, logs and pid files          default <repo>/.dev/native
#   PD_NATIVE_PG_BIN        Postgres 16 bin directory         default /usr/lib/postgresql/16/bin
#   PD_NATIVE_PG_PORT       Postgres port                     default 54329
#   PD_NATIVE_PG_USER       OS user for Postgres and Redis    default pgrun; used only when this script runs as root
#   PD_NATIVE_REDIS_PORT    Redis port                        default 6379
#   PD_DOUBLE_OIDC_PORT, PD_DOUBLE_S3_PORT, PD_DOUBLE_CLAMD_PORT   default 8080, 8333, 3310
#   S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY                    bucket the S3 double starts with, and the keys printed
# Nothing here deletes anything outside PD_NATIVE_DIR, and `stop` deletes nothing at all (data stays for the next start).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NATIVE_DIR="${PD_NATIVE_DIR:-$ROOT/.dev/native}"
PG_BIN="${PD_NATIVE_PG_BIN:-/usr/lib/postgresql/16/bin}"
PG_PORT="${PD_NATIVE_PG_PORT:-54329}"
PG_USER="${PD_NATIVE_PG_USER:-pgrun}"
REDIS_PORT="${PD_NATIVE_REDIS_PORT:-6379}"
OIDC_PORT="${PD_DOUBLE_OIDC_PORT:-8080}"
S3_PORT="${PD_DOUBLE_S3_PORT:-8333}"
CLAMD_PORT="${PD_DOUBLE_CLAMD_PORT:-3310}"
BUCKET="${S3_BUCKET:-pd-local}"
# Dev-only keys of the S3 double (it does not check them).
S3_KEY="${S3_ACCESS_KEY:-dev-only-s3-access}"       # secret-scan: allow
S3_SECRET="${S3_SECRET_KEY:-dev-only-s3-secret-key}" # secret-scan: allow

PG_DIR="$NATIVE_DIR/pg"
REDIS_DIR="$NATIVE_DIR/redis"
RUN_DIR="$NATIVE_DIR/run"
DOUBLES_PID="$RUN_DIR/doubles.pid"
DOUBLES_LOG="$RUN_DIR/doubles.log"

die() { printf 'native-stack: %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }

# Postgres and Redis must not run as root (initdb and postgres refuse). As root, drop to PG_USER.
as_pg_user() {
  if [[ "$(id -u)" == 0 ]]; then
    command -v runuser >/dev/null 2>&1 || die "running as root and runuser is missing"
    id "$PG_USER" >/dev/null 2>&1 || die "running as root and the user $PG_USER does not exist (set PD_NATIVE_PG_USER)"
    runuser -u "$PG_USER" -- "$@"
  else
    "$@"
  fi
}

port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

wait_port() { # port label seconds
  local i
  for ((i = 0; i < $3 * 10; i++)); do
    port_open "$1" && return 0
    sleep 0.1
  done
  die "$2 did not open port $1 within $3 seconds"
}

pg_running() { [[ -f "$PG_DIR/postmaster.pid" ]] && as_pg_user "$PG_BIN/pg_ctl" -D "$PG_DIR" status >/dev/null 2>&1; }
redis_pid_file() { printf '%s' "$RUN_DIR/redis.pid"; }
# A pid file can outlive its process and the number can be reused: also check the command line (/proc) names the program.
pid_is() { # pidfile pattern
  local pid
  [[ -f "$1" ]] || return 1
  pid="$(cat "$1")"
  [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null || return 1
  [[ -r "/proc/$pid/cmdline" ]] || return 0 # no /proc (not Linux): trust kill -0
  tr '\0' ' ' <"/proc/$pid/cmdline" | grep -q -- "$2"
}
redis_running() { pid_is "$(redis_pid_file)" 'redis-server'; }
doubles_running() { pid_is "$DOUBLES_PID" 'doubles.ts'; }

# Creates pg/, redis/ and run/ inside NATIVE_DIR. As root it hands to PG_USER only the directories it created in this run,
# never NATIVE_DIR itself or a directory that was already there. With DRY=1 it prints what it would do and changes nothing
# (PD_NATIVE_ASSUME_ROOT=1 plans as root, for tests).
prepare_dirs() {
  local dry="${1:-0}" d root=0
  [[ "$(id -u)" == 0 || "${PD_NATIVE_ASSUME_ROOT:-}" == 1 ]] && root=1
  for d in "$NATIVE_DIR" "$PG_DIR" "$REDIS_DIR" "$RUN_DIR"; do
    if [[ -d "$d" ]]; then
      say "exists $d"
      continue
    fi
    say "create $d"
    if [[ "$dry" != 1 ]]; then
      mkdir -p "$d"
      # NATIVE_DIR itself stays as it is; only its three children are handed over.
      if [[ "$root" == 1 && "$d" != "$NATIVE_DIR" ]]; then chown "$PG_USER" "$d"; fi
    fi
    if [[ "$root" == 1 && "$d" != "$NATIVE_DIR" ]]; then say "chown $d"; fi
  done
  if [[ "$dry" != 1 && -d "$PG_DIR" ]]; then chmod 700 "$PG_DIR"; fi
}

check_pg_dir_writable() {
  as_pg_user test -w "$PG_DIR" \
    || die "$PG_DIR is not writable by ${PG_USER:-the current user}. $PG_USER must be able to enter every parent directory of $NATIVE_DIR (chmod o+x on them) and own $PG_DIR. Or set PD_NATIVE_DIR to a directory it can use."
}

start_pg() {
  if pg_running; then say "postgres: already running on $PG_PORT"; return 0; fi
  port_open "$PG_PORT" && die "port $PG_PORT is already in use by something that is not this stack's Postgres (set PD_NATIVE_PG_PORT)"
  [[ -x "$PG_BIN/initdb" ]] || die "no Postgres binaries in $PG_BIN (set PD_NATIVE_PG_BIN)"
  check_pg_dir_writable
  if [[ ! -f "$PG_DIR/PG_VERSION" ]]; then
    say "postgres: creating a new cluster in $PG_DIR"
    as_pg_user "$PG_BIN/initdb" -D "$PG_DIR" -U postgres -A trust -E UTF8 --locale=C.UTF-8 >"$RUN_DIR/initdb.log" 2>&1 \
      || die "initdb failed, see $RUN_DIR/initdb.log"
  fi
  as_pg_user "$PG_BIN/pg_ctl" -D "$PG_DIR" -l "$RUN_DIR/postgres.log" -w -t 60 \
    -o "-p $PG_PORT -c listen_addresses=127.0.0.1 -k $RUN_DIR" start >/dev/null \
    || die "pg_ctl start failed, see $RUN_DIR/postgres.log"
  say "postgres: started on $PG_PORT"
}

start_redis() {
  if redis_running; then say "redis: already running on $REDIS_PORT"; return 0; fi
  port_open "$REDIS_PORT" && die "port $REDIS_PORT is already in use (set PD_NATIVE_REDIS_PORT)"
  command -v redis-server >/dev/null 2>&1 || die "redis-server is not installed"
  as_pg_user redis-server --port "$REDIS_PORT" --bind 127.0.0.1 --dir "$REDIS_DIR" --daemonize yes \
    --pidfile "$(redis_pid_file)" --logfile "$RUN_DIR/redis.log" \
    --appendonly yes --maxmemory-policy noeviction >/dev/null
  wait_port "$REDIS_PORT" redis 10
  say "redis: started on $REDIS_PORT"
}

start_doubles() {
  if doubles_running; then say "doubles: already running"; return 0; fi
  local p
  for p in "$OIDC_PORT" "$S3_PORT" "$CLAMD_PORT"; do
    port_open "$p" && die "port $p is already in use (set PD_DOUBLE_OIDC_PORT, PD_DOUBLE_S3_PORT or PD_DOUBLE_CLAMD_PORT)"
  done
  [[ -x "$ROOT/node_modules/.bin/tsx" ]] || die "run pnpm install first (tsx is missing)"
  : >"$DOUBLES_LOG"
  (
    cd "$ROOT"
    PD_DOUBLE_OIDC_PORT="$OIDC_PORT" PD_DOUBLE_S3_PORT="$S3_PORT" PD_DOUBLE_CLAMD_PORT="$CLAMD_PORT" S3_BUCKET="$BUCKET" \
      nohup "$ROOT/node_modules/.bin/tsx" packages/testing/scripts/doubles.ts >>"$DOUBLES_LOG" 2>&1 </dev/null &
    echo $! >"$DOUBLES_PID"
  )
  local i
  for ((i = 0; i < 300; i++)); do
    grep -q '^READY$' "$DOUBLES_LOG" 2>/dev/null && break
    doubles_running || die "the doubles exited, see $DOUBLES_LOG"
    sleep 0.1
  done
  grep -q '^READY$' "$DOUBLES_LOG" || die "the doubles did not become ready, see $DOUBLES_LOG"
  say "doubles: started (oidc $OIDC_PORT, s3 $S3_PORT, clamd $CLAMD_PORT)"
}

print_env() {
  cat <<ENVEOF
export E2E_STACK=native
export PD_ADMIN_DATABASE_URL='postgres://postgres@127.0.0.1:$PG_PORT/postgres'
export TEST_DATABASE_URL='postgres://postgres@127.0.0.1:$PG_PORT/postgres'
export REDIS_URL='redis://127.0.0.1:$REDIS_PORT'
export S3_ENDPOINT='http://127.0.0.1:$S3_PORT'
export S3_BUCKET='$BUCKET'
export S3_ACCESS_KEY='$S3_KEY'
export S3_SECRET_KEY='$S3_SECRET'
export IDENTITY_ZITADEL_URL='http://127.0.0.1:$OIDC_PORT'
export GATEWAY_JWKS_URL='http://127.0.0.1:$OIDC_PORT/jwks'
export CLAMAV_HOST='127.0.0.1'
export CLAMAV_PORT='$CLAMD_PORT'
ENVEOF
}

cmd_start() {
  prepare_dirs 0 >/dev/null
  start_pg
  start_redis
  start_doubles
  say ""
  say "The native stack is up. Export these variables (or: eval \"\$($0 env)\"):"
  print_env
  say ""
  say "Migrate: PD_ADMIN_DATABASE_URL=postgres://postgres@127.0.0.1:$PG_PORT/<scratch db> pnpm migrate"
  say "Stop:    $0 stop"
}

cmd_status() {
  local down=0
  if pg_running; then say "postgres: up (port $PG_PORT)"; else say "postgres: down"; down=1; fi
  if redis_running; then say "redis: up (port $REDIS_PORT)"; else say "redis: down"; down=1; fi
  if doubles_running; then say "doubles: up (oidc $OIDC_PORT, s3 $S3_PORT, clamd $CLAMD_PORT)"; else say "doubles: down"; down=1; fi
  return "$down"
}

cmd_stop() {
  if doubles_running; then
    kill "$(cat "$DOUBLES_PID")" 2>/dev/null || true
    local i
    for ((i = 0; i < 50; i++)); do doubles_running || break; sleep 0.1; done
    say "doubles: stopped"
  else
    say "doubles: not running"
  fi
  rm -f "$DOUBLES_PID"
  if redis_running; then
    kill "$(cat "$(redis_pid_file)")" 2>/dev/null || true
    local j
    for ((j = 0; j < 100; j++)); do redis_running || break; sleep 0.1; done
    say "redis: stopped"
  else
    say "redis: not running"
  fi
  if pg_running; then
    as_pg_user "$PG_BIN/pg_ctl" -D "$PG_DIR" -m fast -w -t 60 stop >/dev/null && say "postgres: stopped"
  else
    say "postgres: not running"
  fi
}

case "${1:-}" in
  start) cmd_start ;;
  status) cmd_status ;;
  env) print_env ;;
  stop) cmd_stop ;;
  prepare-dry-run) prepare_dirs 1 ;;
  -h | --help | help | "")
    sed -n '2,21p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    [[ -n "${1:-}" ]] ;;
  *) die "unknown command: $1 (use start, status, env or stop)" ;;
esac
