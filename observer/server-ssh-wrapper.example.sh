#!/bin/sh
# Example: install on the Coolify host as /usr/local/sbin/scalper-observer-logs.sh (root:root, 0755).
# Point authorized_keys command= to this script for the scalper-observer user.
set -eu

# Replace with the directory on the server that contains this repo's docker-compose.yml.
COMPOSE_DIR="/data/coolify/services/REPLACE_UUID/code"

cd "$COMPOSE_DIR" || exit 1
exec docker compose logs -f --tail=500 bot
