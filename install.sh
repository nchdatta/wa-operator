#!/usr/bin/env bash
# One-step install for macOS and Linux: checks Node 24+, installs cloudflared on macOS (Homebrew),
# npm install, then the setup wizard. Extra arguments go to the wizard, e.g.  ./install.sh --only tunnel
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 24+ is needed: https://nodejs.org (macOS: brew install node@24)"
  exit 1
fi
major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$major" -lt 24 ]; then
  echo "Node $major found, 24+ needed."
  exit 1
fi

if ! command -v cloudflared >/dev/null 2>&1 && [ "$(uname)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
  echo "Installing cloudflared..."
  brew install cloudflared || true
fi

[ -d node_modules ] || npm install
exec npm run setup -- "$@"
