#!/usr/bin/env bash
# Обновление бота из GitHub: git pull -> install -> build -> restart service.
# Запускать от имени пользователя bots на сервере, из любого каталога:
#   sudo -u bots /opt/bots/sklad-bot/deploy/deploy.sh
set -euo pipefail

REPO_DIR="/opt/bots/sklad-bot"
SERVICE_NAME="discord-bot-sliv"

cd "$REPO_DIR"

echo "== git pull =="
git pull --ff-only

echo "== pnpm install =="
pnpm install --frozen-lockfile

echo "== build =="
pnpm --filter @workspace/discord-bot run build

echo "== restart service (требует sudo) =="
sudo systemctl restart "$SERVICE_NAME"
sudo systemctl status "$SERVICE_NAME" --no-pager -l | head -n 10

echo "Готово."
