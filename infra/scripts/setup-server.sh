#!/bin/bash
# Initial server setup script for OVH VPS
# Run this once on a fresh Ubuntu 24.04 server

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${GREEN}=== PD Server Setup ===${NC}"

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}Please run as root${NC}"
  exit 1
fi

# Update system
echo -e "${YELLOW}Updating system packages...${NC}"
apt update && apt upgrade -y

# Install dependencies
echo -e "${YELLOW}Installing dependencies...${NC}"
apt install -y \
  curl \
  git \
  docker.io \
  docker-compose \
  nginx \
  ufw \
  fail2ban \
  certbot \
  python3-certbot-nginx

# Enable Docker
echo -e "${YELLOW}Enabling Docker...${NC}"
systemctl enable docker
systemctl start docker

# Create data directory
echo -e "${YELLOW}Creating data directories...${NC}"
mkdir -p /data/files
mkdir -p /data/backups
chown -R 1000:1000 /data

# Configure firewall
echo -e "${YELLOW}Configuring firewall...${NC}"
ufw default deny incoming
ufw default allow outgoing
ufw allow 22    # SSH
ufw allow 443   # HTTPS
ufw --force enable

# Configure nginx
echo -e "${YELLOW}Configuring nginx...${NC}"
# nginx config will be copied during deployment

# Install pnpm
echo -e "${YELLOW}Installing pnpm...${NC}"
npm install -g pnpm

# Create project directory
echo -e "${YELLOW}Creating project directory...${NC}"
mkdir -p /opt/pd

echo -e "${GREEN}Server setup complete!${NC}"
echo ""
echo "Next steps:"
echo "1. Add your SSH public key to ~/.ssh/authorized_keys"
echo "2. Set up Cloudflare DNS for pd.shaavir.com"
echo "3. Copy Cloudflare Origin certificate to /etc/nginx/ssl/"
echo "4. Run deploy.sh to deploy the application"
