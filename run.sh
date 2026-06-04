#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════
# run.sh — Bengali Digital Library Manager
# Works on Linux and macOS. Run from anywhere after install.
#
# Usage:
#   bengali-library              start / open in browser
#   bengali-library --stop       stop
#   bengali-library --logs       tail logs
#   bengali-library --status     show info
#   bengali-library --update     pull latest image
#   bengali-library --clean      remove container + user data (PDFs untouched)
#   bengali-library --set-library /path   change library path
# ══════════════════════════════════════════════════════════════════════════
set -euo pipefail

C='\033[0;36m'; G='\033[0;32m'; Y='\033[1;33m'
R='\033[0;31m'; B='\033[1m'; N='\033[0m'
info() { echo -e "${C}  →${N} $*"; }
ok()   { echo -e "${G}  ✓${N} $*"; }
warn() { echo -e "${Y}  !${N} $*"; }
die()  { echo -e "${R}  ✗${N} $*" >&2; exit 1; }
hdr()  { echo -e "\n${B}${C}$*${N}\n"; }

IMAGE="ohidsajol/bengali-library:latest"
PORT=7654
APP_DIR="$HOME/.bengali_library_docker"
LIB_FILE="$APP_DIR/library_directory.txt"
DATA_DIR="$APP_DIR/data"
OCR_DIR="$APP_DIR/ocr"
CONTAINER="bengali-library"
URL="http://localhost:$PORT"

# ── Parse args ────────────────────────────────────────────────────────────
MODE="start"
SET_LIB_PATH=""
for arg in "$@"; do
  case "$arg" in
    --stop)        MODE="stop"        ;;
    --logs)        MODE="logs"        ;;
    --status)      MODE="status"      ;;
    --update)      MODE="update"      ;;
    --clean)       MODE="clean"       ;;
    --set-library) MODE="set-library" ;;
    --help|-h)
      grep "^#   bengali" "$0" | sed 's/^#//'
      exit 0 ;;
    *) [ "$MODE" = "set-library" ] && SET_LIB_PATH="$arg" ;;
  esac
done

# ── Docker ────────────────────────────────────────────────────────────────
require_docker() {
  if ! command -v docker &>/dev/null; then
    die "Docker not found. Install from https://docs.docker.com/get-docker/"
  fi
  if ! docker info &>/dev/null 2>&1; then
    warn "Docker daemon not running. Trying to start…"
    sudo systemctl start docker 2>/dev/null \
      || sudo service docker start 2>/dev/null \
      || open -a Docker 2>/dev/null \
      || true
    for i in $(seq 1 15); do
      docker info &>/dev/null 2>&1 && break
      sleep 2
    done
    docker info &>/dev/null 2>&1 || die "Docker not running. Start it manually and retry."
  fi
}

# ── Library path — fully automatic, never asks the user ─────────────────
# Priority:
#  1. Already saved in library_directory.txt (and dir still exists)
#  2. First existing candidate directory from a known list
#  3. ~/bengali-literature — created automatically
resolve_library_path() {
  mkdir -p "$APP_DIR"

  # 1. Already configured and still valid?
  if [ -f "$LIB_FILE" ]; then
    local saved; saved=$(cat "$LIB_FILE" | tr -d '[:space:]')
    if [ -n "$saved" ] && [ -d "$saved" ]; then
      echo "$saved"; return
    fi
  fi

  # 2. Check well-known locations
  local candidates=(
    "$HOME/bengali-literature"
    "$HOME/BengaliLibrary"
    "$HOME/bengali_literature"
    "$HOME/Books/Bengali"
    "$HOME/Documents/bengali-literature"
    "$HOME/Documents/BengaliLibrary"
    "$HOME/Desktop/bengali-literature"
  )
  for c in "${candidates[@]}"; do
    if [ -d "$c" ]; then
      echo "$c" > "$LIB_FILE"
      echo "$c"; return
    fi
  done

  # 3. Create default and save
  local default="$HOME/bengali-literature"
  mkdir -p "$default"
  echo "$default" > "$LIB_FILE"
  echo "$default"
}

set_library_path() {
  local path="${1/#\~/$HOME}"
  [ -d "$path" ] || { mkdir -p "$path"; ok "Created: $path"; }
  mkdir -p "$APP_DIR"
  echo "$path" > "$LIB_FILE"
  ok "Library path set to: $path"
}

# ══════════════════════════════════════════════════════════════════════════
# MODES
# ══════════════════════════════════════════════════════════════════════════

if [ "$MODE" = "set-library" ]; then
  [ -z "$SET_LIB_PATH" ] && { read -r -p "  New library path: " SET_LIB_PATH; }
  set_library_path "$SET_LIB_PATH"
  info "Restart to use new path: bengali-library --stop && bengali-library"
  exit 0
fi

if [ "$MODE" = "stop" ]; then
  require_docker
  if docker ps -q -f "name=$CONTAINER" | grep -q .; then
    docker stop "$CONTAINER" && docker rm "$CONTAINER"
    ok "Stopped."
  else warn "Not running."; fi
  exit 0
fi

if [ "$MODE" = "logs" ]; then
  require_docker; docker logs -f "$CONTAINER"; exit 0
fi

if [ "$MODE" = "status" ]; then
  require_docker
  echo ""
  echo -e "  ${B}Container:${N}"
  docker ps -a --filter "name=$CONTAINER" \
    --format "    {{.Names}}  {{.Status}}  {{.Ports}}" 2>/dev/null \
    || echo "    (not found)"
  LIB_PATH=$(resolve_library_path)
  pdf_count=$(find "$LIB_PATH" -name "*.pdf" 2>/dev/null | wc -l | tr -d ' ')
  echo ""
  echo -e "  ${B}Library:${N}   $LIB_PATH ($pdf_count PDFs)"
  echo -e "  ${B}Data dir:${N}  $DATA_DIR"
  echo -e "  ${B}Image:${N}     $IMAGE"
  echo -e "  ${B}URL:${N}       $URL"
  echo ""
  exit 0
fi

if [ "$MODE" = "update" ]; then
  require_docker
  info "Pulling latest image…"
  docker pull "$IMAGE"
  ok "Updated. Restart: bengali-library --stop && bengali-library"
  exit 0
fi

if [ "$MODE" = "clean" ]; then
  require_docker
  echo -e "  ${Y}This removes the container and user data (recents, favourites, progress).${N}"
  echo "  Your PDF library will NOT be deleted."
  read -r -p "  Continue? [y/N] " yn
  [[ "$yn" =~ ^[Yy]$ ]] || exit 0
  docker stop "$CONTAINER" 2>/dev/null || true
  docker rm   "$CONTAINER" 2>/dev/null || true
  docker rmi  "$IMAGE"     2>/dev/null || true
  rm -rf "$DATA_DIR" "$OCR_DIR"
  ok "Cleaned."
  exit 0
fi

# ══════════════════════════════════════════════════════════════════════════
# START
# ══════════════════════════════════════════════════════════════════════════
hdr "Bengali Digital Library"

require_docker
ok "Docker: $(docker --version 2>/dev/null | awk '{print $3}' | tr -d ',')"

# Ensure data dirs
mkdir -p "$DATA_DIR" "$OCR_DIR"

# Resolve library path automatically
LIB_PATH=$(resolve_library_path)
ok "Library: $LIB_PATH"
pdf_count=$(find "$LIB_PATH" -name "*.pdf" 2>/dev/null | wc -l | tr -d ' ')
info "$pdf_count PDF file(s) found."
[ "$pdf_count" -eq 0 ] && \
  warn "No PDFs yet. Add them to: $LIB_PATH/Author Name/Book.pdf"

# Pull image if not present
if ! docker image inspect "$IMAGE" &>/dev/null; then
  info "Pulling image (first time, ~2 GB, please wait)…"
  docker pull "$IMAGE" || die "Pull failed. Check internet connection."
fi
ok "Image ready."

# Stop any existing container with the same name
if docker ps -aq -f "name=$CONTAINER" | grep -q .; then
  docker stop "$CONTAINER" &>/dev/null || true
  docker rm   "$CONTAINER" &>/dev/null || true
fi

# Start
info "Starting container…"
docker run -d \
  --name "$CONTAINER" \
  --restart unless-stopped \
  -p "$PORT:7654" \
  -v "$LIB_PATH:/app/bengali-literature:rw" \
  -v "$DATA_DIR:/app/what-you-doing:rw" \
  -v "$OCR_DIR:/app/ocr:rw" \
  "$IMAGE"

# Wait for readiness
info "Waiting for app to be ready…"
for i in $(seq 1 45); do
  curl -sf "$URL/api/library" &>/dev/null && break
  sleep 1
  [ $i -eq 45 ] && warn "Slow to start. Check logs: bengali-library --logs"
done
ok "App is ready!"

echo ""
echo -e "  ${B}${G}▶  $URL${N}"
echo ""
echo "  bengali-library --stop            stop the app"
echo "  bengali-library --logs            view logs"
echo "  bengali-library --set-library /path   change library folder"
echo ""

# Open browser
command -v xdg-open &>/dev/null && xdg-open "$URL" 2>/dev/null & true
command -v open     &>/dev/null && open     "$URL" 2>/dev/null & true
