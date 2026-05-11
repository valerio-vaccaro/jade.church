#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${1:-8080}"
HOST="127.0.0.1"

if ! [[ "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 1 || PORT > 65535 )); then
  echo "Invalid port: $PORT"
  echo "Usage: $0 [port]"
  exit 1
fi

cd "$ROOT_DIR"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required but was not found. Install Node.js (npm) and retry."
  exit 1
fi

if [[ ! -d node_modules ]]; then
  echo "Installing dependencies..."
  npm install
fi

echo "Starting Vite dev server..."
echo "Open: http://localhost:$PORT"
echo "Press Ctrl+C to stop."

exec npx vite --host "$HOST" --port "$PORT"
