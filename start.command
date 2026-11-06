#!/bin/bash
# Double-click this file in Finder to start the FARQ site.
cd "$(dirname "$0")"

# Find Node.js (Homebrew, nvm, Volta, official installer).
if ! command -v node >/dev/null 2>&1; then
  for p in /opt/homebrew/bin /usr/local/bin "$HOME"/.nvm/versions/node/*/bin "$HOME/.volta/bin"; do
    [ -x "$p/node" ] && export PATH="$p:$PATH"
  done
fi
if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  Node.js is not installed."
  echo "  Install the LTS version from https://nodejs.org, then double-click start.command again."
  echo ""
  open "https://nodejs.org/en/download"
  read -n 1 -s -r -p "  Press any key to close…"
  exit 1
fi

MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$MAJOR" -lt 22 ]; then
  echo "  Note: Node $(node -v) found. Chat and voice work; live phone calls need Node 22 or newer."
fi

PORT=$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2)
PORT=${PORT:-3000}
(sleep 1.5; open "http://localhost:$PORT") &
node server.js
