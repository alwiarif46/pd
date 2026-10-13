#!/bin/bash
# Deployment script for Proposal Development Tool
# Run this on the OVH VPS after initial server setup

set -e

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

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}Please run as root${NC}"
  exit 1
fi

echo -e "${YELLOW}Pulling latest code from GitHub...${NC}"
if [ -d "$PROJECT_DIR" ]; then
  cd "$PROJECT_DIR"
  git fetch origin
  git checkout "$BRANCH"
  git pull origin "$BRANCH"
else
  git clone -b "$BRANCH" "$GIT_REPO" "$PROJECT_DIR"
  cd "$PROJECT_DIR"
fi

echo -e "${YELLOW}Installing dependencies...${NC}"
cd "$PROJECT_DIR"
npm install -g pnpm
pnpm install

echo -e "${YELLOW}Building all apps...${NC}"
pnpm build

echo -e "${YELLOW}Building Docker images...${NC}"
docker compose -f infra/docker-compose.yml build

echo -e "${YELLOW}Stopping existing containers...${NC}"
docker compose -f infra/docker-compose.yml down

echo -e "${YELLOW}Starting new containers...${NC}"
docker compose -f infra/docker-compose.yml up -d

echo -e "${YELLOW}Creating data directories...${NC}"
mkdir -p "$DATA_DIR"
mkdir -p "$BACKUP_DIR"
chown -R 1000:1000 "$DATA_DIR"

echo -e "${YELLOW}Running database migrations...${NC}"
# TODO: Add migration command once implemented
# docker compose exec api pnpm db:migrate

echo -e "${GREEN}Deployment complete!${NC}"
echo "Check status with: docker compose -f $PROJECT_DIR/infra/docker-compose.yml ps"
echo "View logs with: docker compose -f $PROJECT_DIR/infra/docker-compose.yml logs -f"
