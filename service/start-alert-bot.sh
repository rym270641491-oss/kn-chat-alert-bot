#!/bin/bash
set -euo pipefail

PROJECT_DIR='/Users/iris.y.ran/告警机器人'
ENV_FILE='/Users/iris.y.ran/.config/kn-chat-alert-bot.env'
NODE_BIN='/Users/iris.y.ran/.nvm/versions/node/v24.19.0/bin/node'

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing environment file: $ENV_FILE" >&2
  exit 1
fi

if [ ! -x "$NODE_BIN" ]; then
  echo "Missing Node.js binary: $NODE_BIN" >&2
  exit 1
fi

mkdir -p "$PROJECT_DIR/data"
set -a
source "$ENV_FILE"
set +a

cd "$PROJECT_DIR"
exec "$NODE_BIN" "$PROJECT_DIR/bot.js"
