# ══════════════════════════════════════════════════════════════════════
# Bengali Digital Library — Production Image
# Push to Docker Hub:  docker push ohidsajol/bengali-library:latest
# Pull anywhere:       docker pull ohidsajol/bengali-library:latest
# ══════════════════════════════════════════════════════════════════════
FROM python:3.11-slim

LABEL org.opencontainers.image.title="Bengali Digital Library"
LABEL org.opencontainers.image.description="Offline Bengali PDF library with OCR, duplicate detection, and a beautiful reader"
LABEL org.opencontainers.image.licenses="MIT"

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    TESSDATA_PREFIX=/usr/share/tesseract-ocr/5/tessdata \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# ── Layer 1: System packages (cached unless you change this list) ─────
RUN apt-get update -qq && apt-get install -y --no-install-recommends \
    build-essential cargo rustc \
    curl ghostscript libmagic1 poppler-utils unzip \
    tesseract-ocr tesseract-ocr-ben tesseract-ocr-eng \
 && rm -rf /var/lib/apt/lists/*

# ── Layer 2: Bengali tessdata ─────────────────────────────────────────
RUN set -e; \
    TDIR=$(find /usr/share/tesseract-ocr -name "ben.traineddata" \
           -exec dirname {} \; 2>/dev/null | head -1 || echo ""); \
    [ -z "$TDIR" ] && TDIR=/usr/share/tesseract-ocr/5/tessdata; \
    if [ ! -f "$TDIR/ben.traineddata" ]; then \
      mkdir -p "$TDIR"; \
      curl -fsSL -o "$TDIR/ben.traineddata" \
        "https://github.com/tesseract-ocr/tessdata/raw/main/ben.traineddata"; \
    fi; \
    tesseract --list-langs 2>&1 | grep -E "^[a-z]" | sort | tr '\n' ' '

# ── Layer 3: Python packages (cached unless requirements change) ──────
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# ── Layer 4: Application (changes most often — last for cache) ────────
COPY backend/main.py .
COPY frontend/ ./frontend/

# ── Runtime volume mount points ───────────────────────────────────────
# These are overridden by docker run -v / compose volumes at runtime.
# The app reads library from /app/bengali-literature
# User data  goes to  /app/what-you-doing
# OCR output goes to  /app/ocr
RUN mkdir -p bengali-literature ocr what-you-doing

HEALTHCHECK --interval=15s --timeout=8s --retries=5 \
  CMD curl -sf http://localhost:7654/api/library > /dev/null || exit 1

EXPOSE 7654

# Production: 2 workers, no reload
CMD ["uvicorn", "main:app", \
     "--host", "0.0.0.0", \
     "--port", "7654", \
     "--workers", "2", \
     "--log-level", "warning"]
