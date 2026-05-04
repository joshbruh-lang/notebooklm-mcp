#!/usr/bin/env bash
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Install Node 20+ first: https://nodejs.org" >&2
  exit 1
fi

echo "[1/3] Installing npm dependencies..."
npm install

echo "[2/3] Installing Playwright Chromium..."
npx playwright install chromium

echo "[3/3] Building TypeScript..."
npm run build

cat <<EOF

Setup complete.

Next steps:
  1. npm run login                                   # sign into Google once
  2. claude mcp add --scope user notebooklm -- node "$(pwd)/dist/server.js"
  3. restart Claude Code or Claude Desktop

EOF
