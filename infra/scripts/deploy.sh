#!/bin/bash
# Deployment script for Proposal Development Tool
# Run this on the OVH VPS after initial server setup.
#
# Order: pull code, build images, start the database, run migrations as pd_owner, then
# restart the services. A failed migration stops the deploy before the api and worker are
# touched, so the running version keeps serving the old schema.
#
# Secrets live in $PROJECT_DIR/.env (root-only, mode 600) and are read by docker compose.
# This script never prints them and never runs with `set -x`. See docs/plans/01-infrastructure.md
# section 6 for the one-time setup of the pd_app password, which is set out of band.

set -euo pipefail

echo "=== PD Deployment Script ==="

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# Configuration
PROJECT_DIR="/opt/pd"
DATA_DIR="/data/files"
BACKUP_DIR="/data/backups"
GIT_REPO="https://github.com/alwiarif46/pd.git"
BRANCH="${1:-master}"
ENV_FILE="$PROJECT_DIR/.env"
COMPOSE=(docker compose --env-file "$ENV_FILE" -f "$PROJECT_DIR/infra/docker-compose.yml")

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}Please run as root${NC}"
  exit 1
fi

echo -e "${YELLOW}Pulling latest code from GitHub...${NC}"
if [ -d "$PROJECT_DIR/.git" ]; then
  cd "$PROJECT_DIR"
  git fetch origin
  git checkout "$BRANCH"
  git pull origin "$BRANCH"
else
  git clone -b "$BRANCH" "$GIT_REPO" "$PROJECT_DIR"
  cd "$PROJECT_DIR"
fi

if [ ! -f "$ENV_FILE" ]; then
  echo -e "${RED}Missing $ENV_FILE. Copy .env.example to it and fill in the secrets.${NC}"
  exit 1
fi

echo -e "${YELLOW}Creating data directories...${NC}"
mkdir -p "$DATA_DIR"
mkdir -p "$BACKUP_DIR"
chown -R 1000:1000 "$DATA_DIR"

# Dependencies are installed and the apps built inside the images (build context is the repo root).
echo -e "${YELLOW}Building Docker images...${NC}"
"${COMPOSE[@]}" build
"${COMPOSE[@]}" --profile tools build migrate sandbox

echo -e "${YELLOW}Starting database and redis...${NC}"
"${COMPOSE[@]}" up -d postgres redis
for i in $(seq 1 30); do
  if "${COMPOSE[@]}" exec -T postgres pg_isready -U pd_owner -d pd > /dev/null 2>&1; then
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo -e "${RED}Postgres did not become ready. Deploy stopped; services were not restarted.${NC}"
    exit 1
  fi
  sleep 2
done

# Migrations run as pd_owner (DATABASE_URL is set inside the migrate service from POSTGRES_PASSWORD).
# Output is not echoed back by this script. `set -e` fails the deploy if this exits non-zero.
echo -e "${YELLOW}Running database migrations...${NC}"
if ! "${COMPOSE[@]}" --profile tools run --rm -T migrate; then
  echo -e "${RED}Database migration failed. Deploy stopped; api and worker were not restarted.${NC}"
  exit 1
fi

echo -e "${YELLOW}Restarting services...${NC}"
"${COMPOSE[@]}" up -d --remove-orphans

echo -e "${GREEN}Deployment complete!${NC}"
echo "Check status with: docker compose --env-file $ENV_FILE -f $PROJECT_DIR/infra/docker-compose.yml ps"
echo "View logs with: docker compose --env-file $ENV_FILE -f $PROJECT_DIR/infra/docker-compose.yml logs -f"
