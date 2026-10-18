#!/usr/bin/env bash
# WA Operator installer for macOS and Linux. Install or update with one line in a terminal:
#   curl -fsSL https://wa-operator.wa-operator.workers.dev/install.sh | bash
# Needs no sudo. The app goes to ~/.local/share/wa-operator with the command in ~/.local/bin; settings
# and data stay in ~/Library/Application Support/wa-operator (macOS) or ~/.config/wa-operator (Linux),
# so updates keep them. "wa-operator update" and "wa-operator uninstall" run this same script.
set -euo pipefail

BASE="${WAOP_DOWNLOADS:-https://wa-operator.wa-operator.workers.dev}"
MODE="${WAOP_MODE:-install}"
DIR="$HOME/.local/share/wa-operator"
BIN="$HOME/.local/bin"
if [ "$(uname -s)" = Darwin ]; then
  STATE="$HOME/Library/Application Support/wa-operator"
else
  STATE="${XDG_CONFIG_HOME:-$HOME/.config}/wa-operator"
fi

step() { printf '\n\033[36m> %s\033[0m\n' "$1"; }
ok() { printf '  \033[32mOK\033[0m %s\n' "$1"; }

# Started by "wa-operator update/uninstall": let that program exit first.
if [ -n "${WAOP_WAIT_PID:-}" ]; then
  for _ in $(seq 60); do kill -0 "$WAOP_WAIT_PID" 2>/dev/null || break; sleep 1; done
fi

stop_app() {
  if [ -x "$DIR/node" ]; then "$DIR/node" "$DIR/dist/bin/control.js" stop >/dev/null 2>&1 || true; fi
}

if [ "$MODE" = uninstall ]; then
  step 'Removing WA Operator'
  stop_app
  rm -f "$BIN/wa-operator"
  rm -rf "$DIR"
  ok "app removed. Your settings and data are still in $STATE (delete that folder to remove them too)."
  exit 0
fi

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) TARGET=darwin-arm64 ;;
  Darwin-x86_64) TARGET=darwin-x64 ;;
  Linux-x86_64) TARGET=linux-x64 ;;
  Linux-aarch64 | Linux-arm64) TARGET=linux-arm64 ;;
  *) echo "Sorry, $(uname -s) $(uname -m) is not supported yet." >&2; exit 1 ;;
esac

step 'Downloading WA Operator'
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "$BASE/wa-operator-$TARGET.tar.gz" | tar -xz -C "$TMP"
VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$TMP/wa-operator/package.json" | head -1)"
ok "version $VERSION"

step 'Installing'
WAS_INSTALLED=0
[ -x "$DIR/node" ] && WAS_INSTALLED=1
stop_app
rm -rf "$DIR"
mkdir -p "$(dirname "$DIR")" "$BIN" "$STATE"
mv "$TMP/wa-operator" "$DIR"
touch "$DIR/.installed"
ln -sf "$DIR/wa-operator" "$BIN/wa-operator"
ok "installed to $DIR"

case ":$PATH:" in
  *":$BIN:"*) ;;
  *)
    export PATH="$BIN:$PATH"
    # macOS uses zsh; most Linux desktops use bash.
    RC="$HOME/.bashrc"
    [ "$(uname -s)" = Darwin ] && RC="$HOME/.zshrc"
    grep -qs '.local/bin' "$RC" || echo 'export PATH="$HOME/.local/bin:$PATH"' >>"$RC"
    ;;
esac

if [ ! -x "$BIN/claude" ] && ! command -v claude >/dev/null 2>&1; then
  step 'Installing Claude Code (official installer from Anthropic)'
  curl -fsSL https://claude.ai/install.sh | bash
fi

# Questions need the keyboard, not the downloaded script on stdin.
if [ "$MODE" = update ] || { [ "$WAS_INSTALLED" = 1 ] && [ -f "$STATE/.env" ]; }; then
  step 'Starting WA Operator again'
  "$DIR/wa-operator" start
  ok "updated to $VERSION. Your settings and data were kept."
else
  step 'Setup'
  "$DIR/wa-operator" setup </dev/tty
fi
printf '\nFrom now on, open a terminal and type:  wa-operator   (setup, start, stop, update, uninstall)\n'
