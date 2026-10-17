#!/usr/bin/env bash
# infra/tests/test-local-stack.sh - offline checks of the local stack files (09 s9.1, chat 1 item 11):
# infra/compose/local.yml, local.env.example, the Postgres init script and infra/local/native-stack.sh.
# It starts nothing: no container, no Postgres, no port. The native stack itself is smoke-tested by hand and by the
# @pd/testing tests; here only the script's argument handling and its static properties are checked.
# Usage: bash infra/tests/test-local-stack.sh        exit 0 = all pass (SKIP = docker missing)
# shellcheck disable=SC2015  # test harness: A && ok || bad is intentional
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../ops/tests/lib.sh
. "$HERE/../../ops/tests/lib.sh"
harness_init "$(cd "$HERE/../.." && pwd)"
trap cleanup_tmp EXIT

YML="infra/compose/local.yml"
ENVF="infra/compose/local.env.example"
NS="infra/local/native-stack.sh"

# ------------------------------------------------------------------ CI smoke script
o="$(python3 - <<'PY' 2>&1
import importlib.util, sys
spec = importlib.util.spec_from_file_location("stack_smoke", "infra/compose/ci/stack-smoke.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
print(m.schemas_sql(["app", "billing", "review"]))
PY
)"
[ "$o" = "select nspname from pg_namespace where nspname = any(array['app','billing','review']) order by 1" ] \
  && ok "stack-smoke: the schemas query is well formed" || bad "stack-smoke schemas query" "$o"

# ------------------------------------------------------------------ compose file
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  o="$(docker compose -f "$YML" --env-file "$ENVF" config -q 2>&1)" && ok "docker compose config -q accepts local.yml with local.env.example" || bad "compose config" "$o"
  o="$(docker compose -f "$YML" config -q 2>&1)" && bad "compose config must fail without the env file (secrets have no defaults)" || ok "compose config fails with no env file: secrets are required"
  grep -q "required variable" <<<"$o" && ok "the failure names a required variable" || bad "required variable message" "$o"
  rendered="$(docker compose -f "$YML" --env-file "$ENVF" config 2>/dev/null)"
  svcs="$(docker compose -f "$YML" --env-file "$ENVF" config --services 2>/dev/null | sort | tr '\n' ' ')"
  [[ "$svcs" == "clamav postgres redis s3 s3-init sandbox zitadel " ]] && ok "services: $svcs" || bad "service list" "$svcs"
  grep -q "network_mode: none" <<<"$rendered" && grep -q "read_only: true" <<<"$rendered" && grep -q "no-new-privileges" <<<"$rendered" \
    && ok "sandbox: no network, read-only root, no-new-privileges" || bad "sandbox hardening"
  grep -A3 "cap_drop" <<<"$rendered" | grep -q ALL && ok "sandbox drops all capabilities" || bad "sandbox cap_drop"
  grep -q "pg_isready -h 127.0.0.1" <<<"$rendered" && ok "postgres healthcheck uses TCP (-h 127.0.0.1)" || bad "postgres healthcheck must use TCP"
  grep -q "maxmemory-policy" <<<"$rendered" && grep -q "appendonly" <<<"$rendered" && grep -q "noeviction" <<<"$rendered" \
    && ok "redis: appendonly yes, maxmemory-policy noeviction" || bad "redis flags"
else
  skip "docker compose not installed: compose file validation (CI runs it)"
fi

# Static checks that need no docker.
[[ -z "$(grep -E '^\s*image:' "$YML" | grep -vE ':[^:/ ]+$' ; grep -E '^\s*image:.*:latest$' "$YML")" ]] && ok "every image in local.yml carries an explicit tag, none is :latest" || bad "unpinned image" "$(grep -nE '^\s*image:' "$YML")"
for img in pgvector/pgvector:0.8.7-pg16 redis:7.4.9-alpine ghcr.io/zitadel/zitadel:v4.19.5 clamav/clamav:1.5.4 chrislusf/seaweedfs:4.48; do
  grep -q "image: $img\$" "$YML" && ok "pinned image $img" || bad "image $img missing from $YML"
done
n_img="$(grep -c '^    healthcheck:' "$YML")"
[[ "$n_img" == 6 ]] && ok "6 services have a healthcheck (postgres, redis, zitadel, s3, clamav, sandbox)" || bad "healthcheck count is $n_img, expected 6"
grep -q 'condition: service_healthy' "$YML" && ok "depends_on uses condition: service_healthy" || bad "no service_healthy"
! grep -nE '(PASSWORD|SECRET|MASTERKEY|ACCESS_KEY)[A-Z_]*: +[^$ "]' "$YML" >/dev/null && ok "no secret has a literal value in local.yml" || bad "literal secret in local.yml" "$(grep -nE '(PASSWORD|SECRET|MASTERKEY|ACCESS_KEY)[A-Z_]*: +[^$ "]' "$YML")"
! grep -nE '(PASSWORD|SECRET|MASTERKEY|ACCESS_KEY)[A-Z_]*: *\$\{[A-Z_0-9]+:-' "$YML" >/dev/null && ok "no secret has a default value" || bad "secret with default"
mk="$(sed -n 's/^ZITADEL_MASTERKEY=\([^ ]*\).*/\1/p' "$ENVF")"
[[ ${#mk} == 32 ]] && ok "the example Zitadel master key is 32 characters" || bad "masterkey length ${#mk}"
git ls-files --error-unmatch infra/compose/local.env >/dev/null 2>&1 && bad "infra/compose/local.env is tracked" || ok "infra/compose/local.env is not tracked"
git check-ignore -q infra/compose/local.env && ok "infra/compose/local.env is ignored by git" || bad "local.env is not ignored"
grep -q "revoke connect on database :\"zdb\" from public" "$HERE/../compose/postgres-init/01-databases.sh" && ok "init script revokes PUBLIC connect on the Zitadel database" || bad "init script revoke"
sh -n "$HERE/../compose/postgres-init/01-databases.sh" && ok "init script is valid sh" || bad "init script syntax"

# ------------------------------------------------------------------ native stack script
bash -n "$NS" && ok "native-stack.sh: bash -n" || bad "native-stack.sh syntax"
grep -q '^set -euo pipefail' "$NS" && ok "native-stack.sh: set -euo pipefail" || bad "native-stack.sh strict mode"
o="$(bash "$NS" bogus 2>&1)"; rc=$?
[[ $rc != 0 ]] && grep -q "unknown command" <<<"$o" && ok "native-stack.sh rejects an unknown command" || bad "unknown command" "rc=$rc $o"
o="$(bash "$NS" help 2>&1)"; rc=$?
[[ $rc == 0 ]] && grep -q "PD_NATIVE_PG_PORT" <<<"$o" && ok "native-stack.sh help lists its settings" || bad "help" "rc=$rc $o"
o="$(PD_NATIVE_PG_PORT=54999 PD_NATIVE_REDIS_PORT=6999 PD_DOUBLE_OIDC_PORT=18999 PD_DOUBLE_S3_PORT=18998 PD_DOUBLE_CLAMD_PORT=13999 S3_BUCKET=b1 bash "$NS" env 2>&1)"
for want in "E2E_STACK=native" "54999/postgres" "redis://127.0.0.1:6999" "S3_ENDPOINT='http://127.0.0.1:18998'" "S3_BUCKET='b1'" "IDENTITY_ZITADEL_URL='http://127.0.0.1:18999'" "GATEWAY_JWKS_URL='http://127.0.0.1:18999/jwks'" "CLAMAV_PORT='13999'"; do
  grep -qF -- "$want" <<<"$o" && ok "native-stack.sh env prints $want" || bad "env output lacks $want" "$o"
done
# status on an empty data dir starts nothing and exits 1
S="$TMP/native"; mkdir -p "$S"
o="$(PD_NATIVE_DIR="$S" PD_NATIVE_PG_PORT=54999 bash "$NS" status 2>&1)"; rc=$?
[[ $rc == 1 ]] && grep -q "postgres: down" <<<"$o" && grep -q "doubles: down" <<<"$o" && ok "status on an empty stack: all down, exit 1" || bad "status" "rc=$rc $o"
o="$(PD_NATIVE_DIR="$S" bash "$NS" stop 2>&1)"; rc=$?
[[ $rc == 0 ]] && grep -q "not running" <<<"$o" && ok "stop on an empty stack is a no-op" || bad "stop" "rc=$rc $o"
# As root the script hands over only the directories it creates. Planned as root (PD_NATIVE_ASSUME_ROOT=1) with a dry run:
# an existing NATIVE_DIR is never chowned, a new pg/ redis/ run/ are.
E="$TMP/existing"; mkdir -p "$E"
o="$(PD_NATIVE_DIR="$E" PD_NATIVE_ASSUME_ROOT=1 bash "$NS" prepare-dry-run 2>&1)"
grep -q "^exists $E\$" <<<"$o" && ! grep -q "^chown $E\$" <<<"$o" && grep -q "^chown $E/pg\$" <<<"$o" && grep -q "^chown $E/run\$" <<<"$o" \
  && ok "as root: an existing PD_NATIVE_DIR is not chowned; the new pg/ redis/ run/ are" || bad "prepare-dry-run existing dir" "$o"
[[ ! -e "$E/pg" ]] && ok "the dry run created nothing" || bad "dry run created $E/pg"
mkdir -p "$E/pg"
o="$(PD_NATIVE_DIR="$E" PD_NATIVE_ASSUME_ROOT=1 bash "$NS" prepare-dry-run 2>&1)"
! grep -q "^chown $E/pg\$" <<<"$o" && grep -q "^exists $E/pg\$" <<<"$o" && ok "as root: a pre-existing pg/ is not chowned" || bad "pre-existing pg/" "$o"
if [[ "$(id -u)" != 0 ]]; then
  o="$(PD_NATIVE_DIR="$TMP/fresh/native" bash "$NS" prepare-dry-run 2>&1)"
  ! grep -q "^chown" <<<"$o" && grep -q "^create $TMP/fresh/native\$" <<<"$o" && ok "not root: nothing is chowned" || bad "non-root plan" "$o"
else
  skip "not-root plan (this run is root)"
fi
grep -q "check_pg_dir_writable" "$NS" && grep -q "test -w" "$NS" && ok "native-stack.sh checks PG_DIR is writable before initdb" || bad "writable check missing"
grep -q "/proc/" "$NS" && ok "native-stack.sh verifies /proc/<pid>/cmdline for stale pid files" || bad "cmdline check missing"

# no destructive command anywhere in the script
! grep -nE '\brm +-[a-zA-Z]*r|\bmkfs|\bdd +if=|\bcryptsetup' "$NS" >/dev/null && ok "native-stack.sh has no recursive delete or disk command" || bad "destructive command in native-stack.sh"
if command -v shellcheck >/dev/null 2>&1; then
  shellcheck -S warning -x "$NS" >"$TMP/sc.txt" 2>&1 && ok "shellcheck: native-stack.sh clean" || bad "shellcheck native-stack.sh" "$(cat "$TMP/sc.txt")"
else
  skip "shellcheck not installed (CI runs it over infra/)"
fi

summary
