#!/usr/bin/env bash
# infra/scripts/deploy.sh - deploy PD on the server (runs ON THE SERVER, as root).
# Implements: docs/plans/01-infrastructure.md s6. Run it after infra/scripts/setup-server.sh and the LUKS setup
# (infra/luks/README.md).
#
# Order: checks, pull code, build (or pull) images, start the database, run migrations as pd_owner, then restart the
# services. A failed migration stops the deploy before the api and worker are touched, so the running version keeps
# serving the old schema.
#
# Checks before anything is built (all refuse; there is no override):
#   - /mnt/pddata and /mnt/pdbackup are mounted from /dev/mapper/pddata and /dev/mapper/pdbackup (findmnt). Postgres,
#     Redis and the uploaded files live there; without the mounts they would be written to the unencrypted root disk.
#   - the old named volume infra_postgres_data does not exist (data still in the old place: migrate it first, plan 01 s4).
#   - the hosting subprocessor is known: [infra] subprocessor, or the adapter's own (infra/lib/provider.sh), exported as
#     PD_HOSTING_SUBPROCESSOR; the backup target comes from [backup] subprocessor (PD_BACKUP_SUBPROCESSOR). The api names
#     both in GET /api/about/processing.
#
# Secrets live in $PROJECT_DIR/.env (root-only, mode 600) and are read by docker compose. This script never prints them
# and never runs with `set -x`. The pd_app password is set out of band (plan 01 s6).
#
# Usage: sudo infra/scripts/deploy.sh [REF] [--ref REF] [--pull-tag TAG] [--dry-run] [--tenant PATH]
#        deploy.sh --ci            (the CI forced command, see below)
#   REF / --ref REF   git ref to deploy (default master; the old positional argument still works)
#   --pull-tag TAG    use the pre-built registry images ghcr.io/alwiarif46/pd-<app>:TAG (compose pull) instead of building
#   --ci              read the request from $SSH_ORIGINAL_COMMAND, set by sshd for the forced command of the pddeploy user
#                     (infra/server/deploy-user.sh). It must match  ref=<ref>[ tag=<7-40 hex>]  exactly; anything else is
#                     refused with exit 2 and nothing runs.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_OF_SCRIPT="$(cd "$SCRIPT_DIR/../.." && pwd)"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
say() { printf '%b%s%b\n' "$YELLOW" "$1" "$NC"; }
fail() { printf '%b%s%b\n' "$RED" "$1" "$NC" >&2; exit "${2:-1}"; }

# ------------------------------------------------------------------ arguments
DRY=0 CI=0 REF="" PULL_TAG="" TENANT_ARG=""
while (( $# )); do
  case "$1" in
    --dry-run) DRY=1 ;;
    --ci) CI=1 ;;
    --ref) REF="${2:?--ref needs a value}"; shift ;;
    --pull-tag) PULL_TAG="${2:?--pull-tag needs a tag}"; shift ;;
    --tenant) TENANT_ARG="${2:?--tenant needs a path}"; shift ;;
    -h | --help) sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) fail "unknown argument: $1 (see --help)" 2 ;;
    *) [[ -z "$REF" ]] || fail "only one ref allowed" 2; REF="$1" ;;
  esac
  shift
done

# --ci: the request comes from the SSH client; it is data, never trusted. Parsed BEFORE anything else happens.
if (( CI )); then
  req="${SSH_ORIGINAL_COMMAND:-}"
  re='^ref=([A-Za-z0-9._/-]{1,100})( tag=([0-9a-f]{7,40}))?$'
  if ! [[ "$req" =~ $re ]]; then
    fail "deploy --ci: refusing request (expected 'ref=<ref>[ tag=<hex>]')" 2
  fi
  REF="${BASH_REMATCH[1]}"
  PULL_TAG="${BASH_REMATCH[3]:-}"
  # a ref that git could read as an option, or that climbs out with '..', is not a ref
  if [[ "$REF" == -* || "$REF" == *..* || "$REF" == /* ]]; then fail "deploy --ci: refusing ref '$REF'" 2; fi
fi
REF="${REF:-master}"
[[ "$REF" =~ ^[A-Za-z0-9._/-]{1,100}$ && "$REF" != -* ]] || fail "bad ref: $REF" 2
[[ -z "$PULL_TAG" || "$PULL_TAG" =~ ^[A-Za-z0-9._-]{1,128}$ ]] || fail "bad --pull-tag: $PULL_TAG" 2

echo "=== PD Deployment Script ==="

# ------------------------------------------------------------------ configuration
PROJECT_DIR="${PD_PROJECT_DIR:-/opt/pd}"
GIT_REPO="https://github.com/alwiarif46/pd.git"
ENV_FILE="$PROJECT_DIR/.env"
DATA_MOUNT="${PD_DATA_MOUNT:-/mnt/pddata}"
BACKUP_MOUNT="${PD_BACKUP_MOUNT:-/mnt/pdbackup}"
COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$PROJECT_DIR/infra/docker-compose.yml")

dry() { (( DRY )); }
# run CMD...: prints under --dry-run, executes otherwise
x() { if dry; then printf '[dry-run] %s\n' "$*"; else "$@"; fi; }
# precondition MSG: stop on a failed check; under --dry-run only report it
precondition() { if dry; then printf 'WARN (dry-run continues): %s\n' "$1" >&2; else fail "$1"; fi; }

if (( $(id -u) != 0 )) && ! dry; then fail "Please run as root"; fi

# ------------------------------------------------------------------ 1. encrypted mounts
say "Checking the encrypted volumes..."
for pair in "$DATA_MOUNT:/dev/mapper/pddata" "$BACKUP_MOUNT:/dev/mapper/pdbackup"; do
  mp="${pair%%:*}"; want="${pair#*:}"
  got="$(findmnt -no SOURCE "$mp" 2>/dev/null || true)"
  if [[ "$got" != "$want" ]]; then
    precondition "$mp is not mounted from $want (found: '${got:-not mounted}'). Set up the volumes first (infra/luks/README.md); data must never land on the unencrypted root disk."
  fi
done

# ------------------------------------------------------------------ 2. data still in the old named volume?
if docker volume inspect infra_postgres_data >/dev/null 2>&1; then
  precondition "the old Docker volume infra_postgres_data exists: data is still in the old place on the root disk. Migrate it to $DATA_MOUNT/postgres first (docs/plans/01-infrastructure.md s4); nothing is started so it is not silently left behind."
fi

# ------------------------------------------------------------------ 3. code
say "Pulling latest code from GitHub (ref $REF)..."
if [[ -d "$PROJECT_DIR/.git" ]] || dry; then
  cd "$PROJECT_DIR" 2>/dev/null || cd "$REPO_OF_SCRIPT"
  x git fetch --tags origin
  x git checkout "$REF"
  if git show-ref --verify --quiet "refs/remotes/origin/$REF" 2>/dev/null || dry; then x git pull --ff-only origin "$REF"; fi
else
  x git clone -b "$REF" "$GIT_REPO" "$PROJECT_DIR"
  cd "$PROJECT_DIR"
fi

# ------------------------------------------------------------------ 4. tenant values (from the code just checked out)
LIBROOT="$PROJECT_DIR"
[[ -f "$LIBROOT/infra/lib/tenant.sh" ]] || LIBROOT="$REPO_OF_SCRIPT"
[[ -z "$TENANT_ARG" ]] || export PD_TENANT="$TENANT_ARG"
# shellcheck source=../lib/tenant.sh
. "$LIBROOT/infra/lib/tenant.sh"
# shellcheck source=../lib/provider.sh
. "$LIBROOT/infra/lib/provider.sh"
HOSTING_SUB="$(provider_subprocessor)" || precondition "no hosting subprocessor: set [infra] subprocessor in config/tenant.toml"
[[ -n "${HOSTING_SUB// /}" ]] || precondition "the hosting subprocessor is empty: set [infra] subprocessor in config/tenant.toml"
BACKUP_SUB="$(tenant_get backup.subprocessor "")"
export PD_HOSTING_SUBPROCESSOR="${HOSTING_SUB:-}" PD_BACKUP_SUBPROCESSOR="$BACKUP_SUB"

if [[ ! -f "$ENV_FILE" ]]; then
  precondition "Missing $ENV_FILE. Copy .env.example to it and fill in the secrets."
fi

# ------------------------------------------------------------------ 5. data directories (on the encrypted volume)
say "Creating data directories on $DATA_MOUNT..."
x mkdir -p "$DATA_MOUNT/files" "$DATA_MOUNT/postgres" "$DATA_MOUNT/redis"
x chown 1000:1000 "$DATA_MOUNT/files"
export PD_DATA_ROOT="$DATA_MOUNT"

# ------------------------------------------------------------------ 6. images
if [[ -n "$PULL_TAG" ]]; then
  export PD_IMAGE_PREFIX="ghcr.io/alwiarif46/pd-" PD_IMAGE_TAG="$PULL_TAG"
  say "Pulling images ${PD_IMAGE_PREFIX}<app>:$PULL_TAG..."
  x "${COMPOSE[@]}" pull web api worker
  x "${COMPOSE[@]}" --profile tools pull migrate sandbox
else
  # Dependencies are installed and the apps built inside the images (build context is the repo root).
  say "Building Docker images..."
  x "${COMPOSE[@]}" build
  x "${COMPOSE[@]}" --profile tools build migrate sandbox
fi

# ------------------------------------------------------------------ 7. database, migrations, services
say "Starting database and redis..."
x "${COMPOSE[@]}" up -d postgres redis
if ! dry; then
  for i in $(seq 1 30); do
    if "${COMPOSE[@]}" exec -T postgres pg_isready -U pd_owner -d pd >/dev/null 2>&1; then break; fi
    if [ "$i" -eq 30 ]; then fail "Postgres did not become ready. Deploy stopped; services were not restarted."; fi
    sleep 2
  done
fi

# Migrations run as pd_owner (DATABASE_URL is set inside the migrate service from POSTGRES_PASSWORD).
# Output is not echoed back by this script. `set -e` fails the deploy if this exits non-zero.
say "Running database migrations..."
if ! x "${COMPOSE[@]}" --profile tools run --rm -T migrate; then
  fail "Database migration failed. Deploy stopped; api and worker were not restarted."
fi

say "Restarting services..."
x "${COMPOSE[@]}" up -d --remove-orphans

printf '%bDeployment complete!%b\n' "$GREEN" "$NC"
echo "Check status with: docker compose --env-file $ENV_FILE -f $PROJECT_DIR/infra/docker-compose.yml ps"
echo "View logs with: docker compose --env-file $ENV_FILE -f $PROJECT_DIR/infra/docker-compose.yml logs -f"
