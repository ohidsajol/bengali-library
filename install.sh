#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════
# install.sh — Bengali Digital Library one-command installer
# Linux + macOS. Installs Docker if missing, then installs the app.
#
#   curl -fsSL https://raw.githubusercontent.com/YOURNAME/bengali-library/main/install.sh | bash
# ══════════════════════════════════════════════════════════════════════
set -euo pipefail

G='\033[0;32m'; C='\033[0;36m'; Y='\033[1;33m'; R='\033[0;31m'; B='\033[1m'; N='\033[0m'
ok()   { echo -e "${G}  ✓${N} $*"; }
info() { echo -e "${C}  →${N} $*"; }
warn() { echo -e "${Y}  !${N} $*"; }
die()  { echo -e "${R}  ✗${N} $*" >&2; exit 1; }

APP_DIR="$HOME/.bengali_library_docker"
BIN_DIR="$HOME/.local/bin"
RAW="https://raw.githubusercontent.com/YOURNAME/bengali-library/main"

echo -e "\n${B}${C}Bengali Digital Library — Installer${N}\n"

# ── Install Docker if missing ─────────────────────────────────────────
if ! command -v docker &>/dev/null; then
  warn "Docker not found. Installing automatically..."
  if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS — install via Homebrew or direct download
    if command -v brew &>/dev/null; then
      info "Installing Docker Desktop via Homebrew..."
      brew install --cask docker
    else
      info "Downloading Docker Desktop for Mac..."
      ARCH=$(uname -m)
      if [ "$ARCH" = "arm64" ]; then
        DMG_URL="https://desktop.docker.com/mac/main/arm64/Docker.dmg"
      else
        DMG_URL="https://desktop.docker.com/mac/main/amd64/Docker.dmg"
      fi
      curl -fsSL -o /tmp/Docker.dmg "$DMG_URL"
      hdiutil attach /tmp/Docker.dmg -quiet
      cp -R /Volumes/Docker/Docker.app /Applications/
      hdiutil detach /Volumes/Docker -quiet
      rm /tmp/Docker.dmg
      open -a Docker
      info "Waiting for Docker Desktop to start (60s)..."
      for i in $(seq 1 30); do
        docker info &>/dev/null 2>&1 && break
        sleep 2
      done
    fi
  else
    # Linux — use official Docker install script
    info "Installing Docker Engine via official script..."
    curl -fsSL https://get.docker.com | sh
    sudo usermod -aG docker "$USER" 2>/dev/null || true
    # Start Docker
    sudo systemctl enable docker 2>/dev/null || true
    sudo systemctl start  docker 2>/dev/null || sudo service docker start 2>/dev/null || true
    warn "You may need to log out and back in for Docker group membership to take effect."
    warn "If 'bengali-library' fails, run: newgrp docker && bengali-library"
  fi
fi

# Verify Docker is available
if ! command -v docker &>/dev/null; then
  die "Docker installation failed. Install manually: https://docs.docker.com/get-docker/"
fi
ok "Docker: $(docker --version 2>/dev/null | awk '{print $3}' | tr -d ',')"

# ── Create app dir ────────────────────────────────────────────────────
mkdir -p "$APP_DIR"
ok "App directory: $APP_DIR"

# ── Download run.sh ───────────────────────────────────────────────────
info "Downloading run.sh..."
if command -v curl &>/dev/null; then
  curl -fsSL -o "$APP_DIR/run.sh" "$RAW/run.sh"
elif command -v wget &>/dev/null; then
  wget -qO  "$APP_DIR/run.sh" "$RAW/run.sh"
else
  die "curl or wget is required."
fi
chmod +x "$APP_DIR/run.sh"
ok "run.sh installed."

# ── Install command ───────────────────────────────────────────────────
mkdir -p "$BIN_DIR"
ln -sf "$APP_DIR/run.sh" "$BIN_DIR/bengali-library"

# Try system-wide if writable
if [ -w "/usr/local/bin" ] 2>/dev/null; then
  ln -sf "$APP_DIR/run.sh" "/usr/local/bin/bengali-library"
  ok "Command installed system-wide: /usr/local/bin/bengali-library"
else
  ok "Command installed: $BIN_DIR/bengali-library"
  # Ensure ~/.local/bin is in PATH
  for RC in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
    if [ -f "$RC" ] && ! grep -q "$BIN_DIR" "$RC" 2>/dev/null; then
      echo "" >> "$RC"
      echo "export PATH=\"\$HOME/.local/bin:\$PATH\"" >> "$RC"
    fi
  done
  # Also export for current shell session
  export PATH="$BIN_DIR:$PATH"
fi

# ── Auto-detect / create library directory ───────────────────────────
# This mirrors the logic in run.sh — no prompting
LIB_FILE="$APP_DIR/library_directory.txt"
if [ ! -f "$LIB_FILE" ]; then
  for candidate in \
    "$HOME/bengali-literature" \
    "$HOME/BengaliLibrary" \
    "$HOME/Documents/bengali-literature"; do
    if [ -d "$candidate" ]; then
      echo "$candidate" > "$LIB_FILE"
      ok "Library detected: $candidate"
      break
    fi
  done
  if [ ! -f "$LIB_FILE" ]; then
    mkdir -p "$HOME/bengali-literature"
    echo "$HOME/bengali-literature" > "$LIB_FILE"
    ok "Library directory created: $HOME/bengali-literature"
  fi
fi

echo ""
echo -e "${B}${G}Installation complete!${N}"
echo ""
echo "  Start the app:"
echo "    bengali-library"
echo ""
echo "  Add your PDFs to:"
echo "    $(cat "$LIB_FILE")/Author Name/Book.pdf"
echo ""
