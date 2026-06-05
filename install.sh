#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════
# install.sh — Bengali Digital Library one-command installer
# Linux + macOS. Handles bash, zsh, fish, ksh, tcsh automatically.
#
#   curl -fsSL https://raw.githubusercontent.com/ohidsajol/bengali-library/refs/heads/main/install.sh | bash
# ══════════════════════════════════════════════════════════════════════
set -euo pipefail

G='\033[0;32m'; C='\033[0;36m'; Y='\033[1;33m'; R='\033[0;31m'; B='\033[1m'; N='\033[0m'
ok()   { echo -e "${G}  ✓${N} $*"; }
info() { echo -e "${C}  →${N} $*"; }
warn() { echo -e "${Y}  !${N} $*"; }
die()  { echo -e "${R}  ✗${N} $*" >&2; exit 1; }

APP_DIR="$HOME/.bengali_library_docker"
BIN_DIR="$HOME/.local/bin"
RAW="https://raw.githubusercontent.com/ohidsajol/bengali-library/refs/heads/main"

echo -e "\n${B}${C}Bengali Digital Library — Installer${N}\n"

# ── Install Docker if missing ─────────────────────────────────────────
if ! command -v docker &>/dev/null; then
  warn "Docker not found. Installing automatically..."
  if [[ "$OSTYPE" == "darwin"* ]]; then
    if command -v brew &>/dev/null; then
      info "Installing Docker Desktop via Homebrew..."
      brew install --cask docker
    else
      info "Downloading Docker Desktop for Mac..."
      ARCH=$(uname -m)
      DMG_URL="https://desktop.docker.com/mac/main/amd64/Docker.dmg"
      [ "$ARCH" = "arm64" ] && DMG_URL="https://desktop.docker.com/mac/main/arm64/Docker.dmg"
      curl -fsSL -o /tmp/Docker.dmg "$DMG_URL"
      hdiutil attach /tmp/Docker.dmg -quiet
      cp -R /Volumes/Docker/Docker.app /Applications/
      hdiutil detach /Volumes/Docker -quiet
      rm -f /tmp/Docker.dmg
      open -a Docker
      info "Waiting for Docker Desktop to start (60s)..."
      for i in $(seq 1 30); do
        docker info &>/dev/null 2>&1 && break; sleep 2
      done
    fi
  else
    info "Installing Docker Engine via official script..."
    curl -fsSL https://get.docker.com | sh
    sudo usermod -aG docker "$USER" 2>/dev/null || true
    sudo systemctl enable docker 2>/dev/null || true
    sudo systemctl start  docker 2>/dev/null || sudo service docker start 2>/dev/null || true
  fi
fi

command -v docker &>/dev/null || die "Docker installation failed. See https://docs.docker.com/get-docker/"
ok "Docker: $(docker --version 2>/dev/null | awk '{print $3}' | tr -d ',')"

# ── Create app dir ────────────────────────────────────────────────────
mkdir -p "$APP_DIR"
ok "App directory: $APP_DIR"

# ── Download run.sh ───────────────────────────────────────────────────
info "Downloading run.sh..."
if command -v curl &>/dev/null; then
  curl -fsSL -o "$APP_DIR/run.sh" "$RAW/run.sh"
else
  wget -qO "$APP_DIR/run.sh" "$RAW/run.sh"
fi
chmod +x "$APP_DIR/run.sh"
ok "run.sh installed."

# ══════════════════════════════════════════════════════════════════════
# Install the command into every shell the user might use.
# Strategy (in priority order):
#  1. /usr/local/bin      (system-wide, works for ALL shells if writable)
#  2. /usr/bin            (fallback system-wide)
#  3. ~/.local/bin        (user-local, added to PATH in each shell RC)
#  4. Shell-specific RC files for bash / zsh / fish / ksh / tcsh / dash
# ══════════════════════════════════════════════════════════════════════

INSTALLED_GLOBAL=false

# Try system-wide first (needs no PATH changes — works instantly everywhere)
for sys_bin in /usr/local/bin /usr/bin; do
  if [ -w "$sys_bin" ] 2>/dev/null; then
    ln -sf "$APP_DIR/run.sh" "$sys_bin/bengali-library"
    ok "Installed system-wide: $sys_bin/bengali-library  (works in all shells)"
    INSTALLED_GLOBAL=true
    break
  fi
done

# Try with sudo if not writable
if [ "$INSTALLED_GLOBAL" = false ] && command -v sudo &>/dev/null; then
  if sudo -n true 2>/dev/null; then   # passwordless sudo available
    sudo ln -sf "$APP_DIR/run.sh" /usr/local/bin/bengali-library
    ok "Installed system-wide via sudo: /usr/local/bin/bengali-library"
    INSTALLED_GLOBAL=true
  fi
fi

# Fall back to user-local ~/.local/bin
mkdir -p "$BIN_DIR"
ln -sf "$APP_DIR/run.sh" "$BIN_DIR/bengali-library"

if [ "$INSTALLED_GLOBAL" = false ]; then
  ok "Installed to: $BIN_DIR/bengali-library"
  info "Adding to PATH in all detected shell configs..."

  # ── Helper: append a line to a file only if not already present ──
  append_if_missing() {
    local file="$1" line="$2"
    mkdir -p "$(dirname "$file")" 2>/dev/null || true
    touch "$file" 2>/dev/null || true
    grep -qxF "$line" "$file" 2>/dev/null || echo "$line" >> "$file"
  }

  PATH_LINE='export PATH="$HOME/.local/bin:$PATH"'

  # ── bash ──────────────────────────────────────────────────────────
  for f in "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do
    [ -f "$f" ] || continue
    append_if_missing "$f" "$PATH_LINE"
    ok "  bash:   $f"
  done
  # Create .bashrc if none exist
  if [ ! -f "$HOME/.bashrc" ] && [ ! -f "$HOME/.bash_profile" ]; then
    append_if_missing "$HOME/.bashrc" "$PATH_LINE"
    ok "  bash:   $HOME/.bashrc  (created)"
  fi

  # ── zsh ───────────────────────────────────────────────────────────
  ZDOTDIR="${ZDOTDIR:-$HOME}"
  for f in "$ZDOTDIR/.zshrc" "$ZDOTDIR/.zprofile" "$HOME/.zshenv"; do
    [ -f "$f" ] || [ "$f" = "$ZDOTDIR/.zshrc" ] && {
      append_if_missing "$f" "$PATH_LINE"
      ok "  zsh:    $f"
    }
  done

  # ── fish ──────────────────────────────────────────────────────────
  FISH_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/fish"
  if command -v fish &>/dev/null || [ -d "$FISH_CONFIG_DIR" ]; then
    mkdir -p "$FISH_CONFIG_DIR/conf.d"
    FISH_PATH_FILE="$FISH_CONFIG_DIR/conf.d/bengali_library_path.fish"
    FISH_LINE="fish_add_path \$HOME/.local/bin"
    append_if_missing "$FISH_PATH_FILE" "$FISH_LINE"
    ok "  fish:   $FISH_PATH_FILE"
  fi

  # ── ksh (ksh93, mksh, pdksh) ─────────────────────────────────────
  for f in "$HOME/.kshrc" "$HOME/.profile"; do
    [ -f "$f" ] && {
      append_if_missing "$f" "$PATH_LINE"
      ok "  ksh:    $f"
    }
  done

  # ── tcsh / csh ───────────────────────────────────────────────────
  for f in "$HOME/.tcshrc" "$HOME/.cshrc"; do
    [ -f "$f" ] && {
      TCSH_LINE='setenv PATH "$HOME/.local/bin:$PATH"'
      append_if_missing "$f" "$TCSH_LINE"
      ok "  tcsh:   $f"
    }
  done

  # ── dash / sh (usually shares .profile) ──────────────────────────
  [ -f "$HOME/.profile" ] && {
    append_if_missing "$HOME/.profile" "$PATH_LINE"
    ok "  sh:     $HOME/.profile"
  }

  # ── xonsh ────────────────────────────────────────────────────────
  XONSH_RC="${XDG_CONFIG_HOME:-$HOME/.config}/xonsh/rc.xsh"
  if command -v xonsh &>/dev/null || [ -f "$XONSH_RC" ]; then
    mkdir -p "$(dirname "$XONSH_RC")"
    XONSH_LINE="\$PATH.insert(0, str(p'\$HOME/.local/bin'))"
    append_if_missing "$XONSH_RC" "$XONSH_LINE"
    ok "  xonsh:  $XONSH_RC"
  fi

  # ── nushell ──────────────────────────────────────────────────────
  NU_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/nushell"
  if command -v nu &>/dev/null || [ -d "$NU_CONFIG_DIR" ]; then
    mkdir -p "$NU_CONFIG_DIR"
    NU_ENV="$NU_CONFIG_DIR/env.nu"
    NU_LINE="\$env.PATH = (\$env.PATH | prepend ([$HOME/.local/bin] | path expand))"
    append_if_missing "$NU_ENV" "$NU_LINE"
    ok "  nushell: $NU_ENV"
  fi

  # ── Also export right now so bengali-library works in THIS session ─
  export PATH="$BIN_DIR:$PATH"
fi

# ── Auto-detect / create library directory (no prompting) ─────────────
LIB_FILE="$APP_DIR/library_directory.txt"
if [ ! -f "$LIB_FILE" ]; then
  for candidate in \
    "$HOME/bengali-literature" \
    "$HOME/BengaliLibrary" \
    "$HOME/bengali_literature" \
    "$HOME/Documents/bengali-literature" \
    "$HOME/Desktop/bengali-literature"; do
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

LIB_PATH=$(cat "$LIB_FILE")

# ══════════════════════════════════════════════════════════════════════
echo ""
echo -e "${B}${G}Installation complete!${N}"
echo ""

if [ "$INSTALLED_GLOBAL" = true ]; then
  echo "  The command is available system-wide in all shells."
else
  echo "  The command is available after opening a new terminal."
  echo "  To use it RIGHT NOW in this session:"
  echo ""
  echo -e "    ${C}export PATH=\"\$HOME/.local/bin:\$PATH\"${N}"
  echo ""
fi

echo "  Start the app:"
echo -e "    ${C}bengali-library${N}"
echo ""
echo "  Add your PDFs to:"
echo -e "    ${Y}$LIB_PATH/Author Name/Book.pdf${N}"
echo ""
