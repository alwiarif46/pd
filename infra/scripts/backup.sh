#!/bin/bash
# Database backup script for Proposal Development Tool
# Run this daily via cron

set -e

BACKUP_DIR="/data/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/pg_backup_$TIMESTAMP.dump"
RETENTION_DAYS=30

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${YELLOW}Starting database backup...${NC}"

# Create backup directory if it doesn't exist
mkdir -p "$BACKUP_DIR"

# Run pg_dump from the postgres container
docker compose exec -T postgres pg_dump -U pd_owner pd > "$BACKUP_FILE"

# Compress the backup
gzip "$BACKUP_FILE"
BACKUP_FILE="${BACKUP_FILE}.gz"

echo -e "${GREEN}Backup created: $BACKUP_FILE${NC}"

# Delete old backups
find "$BACKUP_DIR" -name "pg_backup_*.dump.gz" -mtime +$RETENTION_DAYS -delete
echo -e "${GREEN}Old backups older than $RETENTION_DAYS days deleted${NC}"

# Calculate backup size
BACKUP_SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
echo -e "${GREEN}Backup size: $BACKUP_SIZE${NC}"
