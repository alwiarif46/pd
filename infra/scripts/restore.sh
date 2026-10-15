#!/bin/bash
# Database restore script for Proposal Development Tool
# Usage: ./restore.sh <backup-file.gz>

set -e

BACKUP_DIR="/data/backups"
BACKUP_FILE="$1"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

if [ -z "$BACKUP_FILE" ]; then
  echo -e "${RED}Usage: $0 <backup-file.gz>${NC}"
  echo "Available backups:"
  ls -lh "$BACKUP_DIR"/pg_backup_*.dump.gz 2>/dev/null || echo "No backups found"
  exit 1
fi

if [ ! -f "$BACKUP_FILE" ]; then
  BACKUP_FILE="$BACKUP_DIR/$BACKUP_FILE"
  if [ ! -f "$BACKUP_FILE" ]; then
    echo -e "${RED}Backup file not found: $BACKUP_FILE${NC}"
    exit 1
  fi
fi

echo -e "${YELLOW}This will restore the database from: $BACKUP_FILE${NC}"
echo -e "${RED}This will replace all current data!${NC}"
read -p "Are you sure? (yes/no): " CONFIRM

if [ "$CONFIRM" != "yes" ]; then
  echo "Restore cancelled"
  exit 0
fi

echo -e "${YELLOW}Decompressing backup...${NC}"
gunzip -c "$BACKUP_FILE" > /tmp/pg_restore.dump

echo -e "${YELLOW}Restoring database...${NC}"
docker compose exec -T postgres psql -U pd_owner pd < /tmp/pg_restore.dump

rm /tmp/pg_restore.dump

echo -e "${GREEN}Restore complete!${NC}"
