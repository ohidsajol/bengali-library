"""
backend/main.py - Bengali Digital Library API
==============================================

New OCR behaviour (v2):
  - Output filename: <stem>__ocred__<timestamp>.pdf  stored IN bengali-literature/<Author>/
  - Replaces the original file atomically on success
  - Library cache is invalidated immediately after replacement
  - Cancel endpoint: POST /api/ocr/cancel/{job_id}
    kills the ocrmypdf subprocess and removes any partial output
  - Uses all available CPU cores (os.cpu_count())
  - Detects already-OCRed files by __ocred__ in filename
  - /api/ocr/check returns {already_ocred: bool} so the UI can badge them
"""

import os
import re
import sys
import json
import uuid
import time
import shutil
import signal
import asyncio
import platform
import subprocess
import threading
from datetime import datetime
from pathlib import Path
from typing import AsyncGenerator

from fastapi import FastAPI, HTTPException, BackgroundTasks
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

# ---------------------------------------------------------------------------
# PATHS
# main.py lives at /app/main.py  →  BASE_DIR = /app
# ---------------------------------------------------------------------------
BASE_DIR     = Path(__file__).parent.resolve()
LIBRARY_DIR  = BASE_DIR / "bengali-literature"
OCR_DIR      = BASE_DIR / "ocr"          # kept only for temp workspace
FRONTEND_DIR = BASE_DIR / "frontend"
OCR_DIR.mkdir(exist_ok=True)

CPU_COUNT = os.cpu_count() or 2          # use all cores for OCR

# Pattern that marks an already-OCRed filename
OCR_MARKER = "__ocred__"

# ---------------------------------------------------------------------------
# APP
# ---------------------------------------------------------------------------
app = FastAPI(title="Bengali Digital Library API", version="2.0.0", docs_url="/api/docs")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory OCR job store
# { job_id: {status, progress, message, output_path, pages, error,
#            book_path, original_path, cancel_event, proc} }
ocr_jobs: dict = {}

# ---------------------------------------------------------------------------
# HELPERS
# ---------------------------------------------------------------------------

def is_already_ocred(path: str) -> bool:
    """Return True if the filename contains the OCR marker."""
    return OCR_MARKER in Path(path).stem

def build_ocred_filename(original_path: Path) -> Path:
    """
    /app/bengali-literature/Author/Book.pdf
    →  /app/bengali-literature/Author/Book__ocred__20240521_143022.pdf
    """
    ts   = datetime.now().strftime("%Y%m%d_%H%M%S")
    stem = original_path.stem
    # If the stem already has __ocred__ strip the old timestamp and re-stamp
    if OCR_MARKER in stem:
        stem = stem[:stem.index(OCR_MARKER)]
    new_name = f"{stem}{OCR_MARKER}{ts}.pdf"
    return original_path.parent / new_name

# ---------------------------------------------------------------------------
# LIBRARY SCANNING
# ---------------------------------------------------------------------------

def scan_library() -> list:
    if not LIBRARY_DIR.exists():
        return []
    library = []
    for author_dir in sorted(LIBRARY_DIR.iterdir(), key=lambda d: d.name.lower()):
        if not author_dir.is_dir():
            continue
        author_display = author_dir.name.replace('_', ' ').strip()
        books = []
        for pdf in sorted(author_dir.glob("*.pdf"), key=lambda f: f.name.lower()):
            title    = pdf.stem.replace('_', ' ').strip()
            rel_path = pdf.relative_to(BASE_DIR).as_posix()
            already_ocred = is_already_ocred(rel_path)
            books.append({
                "title":         title,
                "path":          rel_path,
                "already_ocred": already_ocred,
            })
        if books:
            library.append({"author": author_display, "books": books})
    return library

_library_cache: list  = []
_library_mtime: float = 0.0
_library_lock = threading.Lock()

def get_library() -> list:
    global _library_cache, _library_mtime
    try:
        mtime = LIBRARY_DIR.stat().st_mtime
    except FileNotFoundError:
        return []
    with _library_lock:
        if mtime != _library_mtime or not _library_cache:
            _library_cache = scan_library()
            _library_mtime = mtime
    return _library_cache

def invalidate_library_cache():
    global _library_mtime
    with _library_lock:
        _library_mtime = 0.0

# ---------------------------------------------------------------------------
# ROUTES - Library
# ---------------------------------------------------------------------------

@app.get("/api/library")
def api_library():
    lib = get_library()
    return {
        "authors": len(lib),
        "books":   sum(len(a["books"]) for a in lib),
        "library": lib,
    }

@app.get("/api/library/refresh")
def api_library_refresh():
    invalidate_library_cache()
    lib = get_library()
    return {
        "authors": len(lib),
        "books":   sum(len(a["books"]) for a in lib),
        "library": lib,
    }

# ---------------------------------------------------------------------------
# ROUTES - PDF serving
# ---------------------------------------------------------------------------

@app.get("/pdf/{path:path}")
def serve_pdf(path: str):
    try:
        full = (BASE_DIR / path).resolve()
        full.relative_to(BASE_DIR)
    except ValueError:
        raise HTTPException(400, "Invalid path")
    if not full.exists() or not full.is_file():
        raise HTTPException(404, f"Not found: {path}")
    if full.suffix.lower() != ".pdf":
        raise HTTPException(400, "Only PDFs served here")
    return FileResponse(
        path=str(full),
        media_type="application/pdf",
        filename=full.name,
        headers={"Content-Disposition": "inline", "Accept-Ranges": "bytes"},
    )

# ---------------------------------------------------------------------------
# OCR CORE  (runs in thread pool)
# ---------------------------------------------------------------------------

class OcrRequest(BaseModel):
    book_path: str
    language:  str = "ben+eng"


def _run_ocr_sync(job_id: str, input_path: Path, language: str):
    """
    Main OCR worker.  Runs in a thread.

    Steps:
      1. OCR input_path → temp file in OCR_DIR
      2. If cancel_event is set at any point → clean up temp, mark cancelled
      3. On success → rename temp to <stem>__ocred__<ts>.pdf in same dir as original
         → delete original
         → invalidate library cache
    """
    job = ocr_jobs[job_id]
    cancel_event: threading.Event = job["cancel_event"]

    def upd(msg: str, pct: int):
        job["message"]  = msg
        job["progress"] = pct

    def cancelled() -> bool:
        return cancel_event.is_set()

    # Build paths
    final_path = build_ocred_filename(input_path)   # where we want it to end up
    temp_path  = OCR_DIR / f"_tmp_{job_id}_{input_path.stem}.pdf"
    job["temp_path"]  = str(temp_path)
    job["final_path"] = str(final_path)

    upd("Starting OCR engine...", 5)
    time.sleep(0.2)
    if cancelled():
        _cleanup_cancel(job_id, temp_path)
        return

    # ── Strategy 1: ocrmypdf Python API ──────────────────────────────
    success = False
    try:
        import ocrmypdf
        upd(f"Tesseract ({language}) — {CPU_COUNT} cores...", 12)

        # ocrmypdf doesn't have a clean cancel hook; we run it in a
        # subprocess via the CLI so we can send SIGTERM on cancel.
        # Use the API only if cancel hasn't been requested.
        if not cancelled():
            upd("Recognising text (ben+eng)...", 25)
            ocrmypdf.ocr(
                input_file   = str(input_path),
                output_file  = str(temp_path),
                language     = language,
                force_ocr    = True,
                skip_big     = True,
                optimize     = 1,
                progress_bar = False,
                jobs         = CPU_COUNT,
            )
            if not cancelled():
                success = True

    except ImportError:
        upd("ocrmypdf API not found — trying CLI...", 18)
    except Exception as e:
        if cancelled():
            _cleanup_cancel(job_id, temp_path)
            return
        upd(f"API error: {e} — trying CLI...", 18)

    # ── Strategy 2: ocrmypdf CLI (subprocess — cancellable) ──────────
    if not success and not cancelled():
        try:
            upd("Running ocrmypdf CLI...", 22)
            proc = subprocess.Popen(
                [
                    "ocrmypdf",
                    "--language",  language,
                    "--force-ocr",
                    "--skip-big",  "100",
                    "--optimize",  "1",
                    "--jobs",      str(CPU_COUNT),
                    str(input_path),
                    str(temp_path),
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            job["proc"] = proc

            # Poll for completion or cancellation
            while proc.poll() is None:
                if cancelled():
                    proc.terminate()
                    try:
                        proc.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                    _cleanup_cancel(job_id, temp_path)
                    return
                time.sleep(0.3)

            job["proc"] = None
            if proc.returncode == 0:
                success = True
            else:
                err = (proc.stderr.read() or b"").decode(errors="replace").strip()
                upd(f"CLI failed ({proc.returncode}): {err[:120]} — falling back...", 25)

        except FileNotFoundError:
            upd("CLI not found — falling back to pytesseract...", 25)
        except Exception as e:
            if cancelled():
                _cleanup_cancel(job_id, temp_path)
                return
            upd(f"CLI error: {e} — falling back...", 25)

    # ── Strategy 3: pytesseract page-by-page ─────────────────────────
    if not success and not cancelled():
        try:
            import pytesseract, io
            from pdf2image import convert_from_path

            upd("Converting PDF pages to images...", 30)
            pages_imgs = convert_from_path(str(input_path), dpi=300)
            total = len(pages_imgs)
            pdf_pages = []

            for i, img in enumerate(pages_imgs):
                if cancelled():
                    _cleanup_cancel(job_id, temp_path)
                    return
                pct = 30 + int(58 * (i / total))
                upd(f"Page {i+1}/{total}...", pct)
                pdf_pages.append(
                    pytesseract.image_to_pdf_or_hocr(img, lang=language, extension="pdf")
                )

            if cancelled():
                _cleanup_cancel(job_id, temp_path)
                return

            upd("Merging pages...", 91)
            _merge_pdfs(pdf_pages, temp_path)
            success = True

        except Exception as e:
            if cancelled():
                _cleanup_cancel(job_id, temp_path)
                return
            job.update({
                "status":  "error",
                "progress": 0,
                "message": f"All OCR strategies failed: {e}",
                "error":   str(e),
            })
            _cleanup_temp(temp_path)
            return

    if cancelled():
        _cleanup_cancel(job_id, temp_path)
        return

    if not success:
        job.update({"status": "error", "progress": 0,
                    "message": "OCR produced no output.", "error": "no output"})
        _cleanup_temp(temp_path)
        return

    # ── Atomic replace: temp → final location, delete original ───────
    upd("Replacing original file...", 96)
    try:
        shutil.move(str(temp_path), str(final_path))
        # Delete original only after the new file is safely in place
        if input_path.exists() and input_path != final_path:
            input_path.unlink()
        # Invalidate library so next GET /api/library returns fresh data
        invalidate_library_cache()

        pages = _count_pages(final_path)
        rel   = final_path.relative_to(BASE_DIR).as_posix()
        job.update({
            "status":       "done",
            "progress":     100,
            "message":      f"Done! {pages} searchable pages.",
            "output_path":  rel,
            "pages":        pages,
        })
    except Exception as e:
        job.update({
            "status":  "error",
            "progress": 0,
            "message": f"Failed to replace original file: {e}",
            "error":   str(e),
        })
        _cleanup_temp(temp_path)


def _cleanup_cancel(job_id: str, temp_path: Path):
    _cleanup_temp(temp_path)
    job = ocr_jobs.get(job_id, {})
    job.update({
        "status":   "cancelled",
        "progress": 0,
        "message":  "OCR cancelled. Original file unchanged.",
    })


def _cleanup_temp(temp_path: Path):
    try:
        if temp_path and temp_path.exists():
            temp_path.unlink()
    except Exception:
        pass


def _merge_pdfs(pdf_bytes_list: list, output_path: Path):
    import io
    try:
        import pypdf
        writer = pypdf.PdfWriter()
        for data in pdf_bytes_list:
            for page in pypdf.PdfReader(io.BytesIO(data)).pages:
                writer.add_page(page)
        with open(output_path, "wb") as f:
            writer.write(f)
        return
    except ImportError:
        pass
    with open(output_path, "wb") as f:
        f.write(pdf_bytes_list[0] if pdf_bytes_list else b"")


def _count_pages(pdf_path: Path) -> int:
    try:
        import pypdf
        with open(pdf_path, "rb") as f:
            return len(pypdf.PdfReader(f).pages)
    except Exception:
        return 0

# ---------------------------------------------------------------------------
# ROUTES - OCR
# ---------------------------------------------------------------------------

@app.post("/api/ocr")
async def api_ocr_start(req: OcrRequest, background_tasks: BackgroundTasks):
    # Validate path
    try:
        input_path = (BASE_DIR / req.book_path).resolve()
        input_path.relative_to(BASE_DIR)
    except ValueError:
        raise HTTPException(400, "Invalid book_path")
    if not input_path.exists():
        raise HTTPException(404, f"Not found: {req.book_path}")

    # Already OCRed?
    if is_already_ocred(req.book_path):
        return {
            "job_id":        None,
            "status":        "already_ocred",
            "already_ocred": True,
            "output_path":   req.book_path,
            "message":       "File is already OCRed.",
        }

    job_id = str(uuid.uuid4())[:8]
    cancel_event = threading.Event()
    ocr_jobs[job_id] = {
        "status":       "running",
        "progress":     0,
        "message":      "Queued...",
        "output_path":  None,
        "pages":        0,
        "error":        None,
        "book_path":    req.book_path,
        "started_at":   time.time(),
        "cancel_event": cancel_event,
        "proc":         None,
        "temp_path":    None,
        "final_path":   None,
    }

    loop = asyncio.get_event_loop()
    background_tasks.add_task(
        loop.run_in_executor,
        None, _run_ocr_sync, job_id, input_path, req.language,
    )
    return {"job_id": job_id, "status": "running"}


@app.post("/api/ocr/cancel/{job_id}")
def api_ocr_cancel(job_id: str):
    if job_id not in ocr_jobs:
        raise HTTPException(404, "Job not found")
    job = ocr_jobs[job_id]
    if job["status"] != "running":
        return {"ok": False, "message": f"Job is already {job['status']}"}
    # Signal the worker thread
    job["cancel_event"].set()
    # If we have a live subprocess, terminate it immediately
    proc = job.get("proc")
    if proc and proc.poll() is None:
        try:
            proc.terminate()
        except Exception:
            pass
    return {"ok": True, "message": "Cancel signal sent."}


@app.get("/api/ocr/status/{job_id}")
def api_ocr_status(job_id: str):
    if job_id not in ocr_jobs:
        raise HTTPException(404, "Job not found")
    j = ocr_jobs[job_id]
    return {k: v for k, v in j.items()
            if k not in ("cancel_event", "proc")}   # don't serialise non-JSON objects


@app.get("/api/ocr/events/{job_id}")
async def api_ocr_events(job_id: str):
    if job_id not in ocr_jobs:
        raise HTTPException(404, "Job not found")

    async def gen() -> AsyncGenerator[str, None]:
        while True:
            job  = ocr_jobs.get(job_id, {})
            data = json.dumps({
                "status":      job.get("status"),
                "progress":    job.get("progress", 0),
                "message":     job.get("message", ""),
                "output_path": job.get("output_path"),
                "pages":       job.get("pages", 0),
                "error":       job.get("error"),
            })
            yield f"data: {data}\n\n"
            if job.get("status") in ("done", "error", "cancelled"):
                break
            await asyncio.sleep(0.35)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/ocr/check")
def api_ocr_check(book_path: str):
    """
    Returns:
      already_ocred: True  if the filename contains __ocred__
      exists:        always True if the file is on disk (same thing here)
    """
    already = is_already_ocred(book_path)
    full    = (BASE_DIR / book_path).resolve()
    return {
        "already_ocred": already,
        "exists":        full.exists(),
        "path":          book_path if already else None,
    }

# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# ROUTES - Annotate  (burn highlights/underlines into PDF, replace in-place)
# ---------------------------------------------------------------------------

class AnnotationRect(BaseModel):
    page:   int          # 1-based
    x:      float        # PDF-space coordinates (bottom-left origin)
    y:      float
    width:  float
    height: float
    color:  str = "#FFFF00"   # hex colour
    type:   str = "highlight" # "highlight" | "underline"

class AnnotateRequest(BaseModel):
    book_path:   str
    annotations: list[AnnotationRect]

@app.post("/api/annotate")
def api_annotate(req: AnnotateRequest):
    """
    Burn annotations (highlights / underlines) into a PDF in-place.
    Uses pypdf to add annotation objects directly — no re-rasterisation,
    text layer is preserved.
    """
    try:
        full = (BASE_DIR / req.book_path).resolve()
        full.relative_to(BASE_DIR)
    except ValueError:
        raise HTTPException(400, "Invalid path")
    if not full.exists():
        raise HTTPException(404, "File not found")
    if not req.annotations:
        return {"ok": True, "message": "No annotations to add."}

    try:
        import pypdf
        import pypdf.generic as generic
        from copy import deepcopy

        reader = pypdf.PdfReader(str(full))
        writer = pypdf.PdfWriter()

        # Copy all pages into writer
        for page in reader.pages:
            writer.add_page(page)

        def _hex_to_rgb(h: str):
            h = h.lstrip('#')
            if len(h) == 3:
                h = ''.join(c*2 for c in h)
            r, g, b = int(h[0:2],16), int(h[2:4],16), int(h[4:6],16)
            return r/255, g/255, b/255

        # Group annotations by page
        by_page: dict = {}
        for ann in req.annotations:
            by_page.setdefault(ann.page, []).append(ann)

        for page_num, anns in by_page.items():
            if page_num < 1 or page_num > len(writer.pages):
                continue
            page = writer.pages[page_num - 1]

            # Get or create /Annots array
            if "/Annots" not in page:
                page[generic.NameObject("/Annots")] = generic.ArrayObject()
            annots = page["/Annots"]

            for ann in anns:
                r, g, b = _hex_to_rgb(ann.color)
                rect = generic.ArrayObject([
                    generic.FloatObject(ann.x),
                    generic.FloatObject(ann.y),
                    generic.FloatObject(ann.x + ann.width),
                    generic.FloatObject(ann.y + ann.height),
                ])

                subtype = "/Highlight" if ann.type == "highlight" else "/Underline"

                # QuadPoints: four corners of the rect (required for Highlight/Underline)
                qp = generic.ArrayObject([
                    generic.FloatObject(ann.x),             generic.FloatObject(ann.y + ann.height),
                    generic.FloatObject(ann.x + ann.width), generic.FloatObject(ann.y + ann.height),
                    generic.FloatObject(ann.x),             generic.FloatObject(ann.y),
                    generic.FloatObject(ann.x + ann.width), generic.FloatObject(ann.y),
                ])

                annot_obj = generic.DictionaryObject({
                    generic.NameObject("/Type"):       generic.NameObject("/Annot"),
                    generic.NameObject("/Subtype"):    generic.NameObject(subtype),
                    generic.NameObject("/Rect"):       rect,
                    generic.NameObject("/QuadPoints"): qp,
                    generic.NameObject("/C"): generic.ArrayObject([
                        generic.FloatObject(r),
                        generic.FloatObject(g),
                        generic.FloatObject(b),
                    ]),
                    generic.NameObject("/CA"):   generic.FloatObject(0.5),
                    generic.NameObject("/F"):    generic.NumberObject(4),
                    generic.NameObject("/P"):    page.indirect_reference or generic.NullObject(),
                })

                indirect = writer._add_object(annot_obj)
                annots.append(indirect)

        # Write to temp file then atomically replace
        tmp = full.with_suffix('.annotating.pdf')
        with open(tmp, 'wb') as f:
            writer.write(f)
        shutil.move(str(tmp), str(full))
        invalidate_library_cache()

        return {"ok": True, "message": f"{len(req.annotations)} annotation(s) saved."}

    except Exception as e:
        raise HTTPException(500, f"Annotation failed: {e}")

# ROUTES - Download
# ---------------------------------------------------------------------------

@app.get("/api/download")
def api_download(path: str):
    try:
        full = (BASE_DIR / path).resolve()
        full.relative_to(BASE_DIR)
    except ValueError:
        raise HTTPException(400, "Invalid path")
    if not full.exists():
        raise HTTPException(404, "Not found")
    return FileResponse(
        path=str(full),
        media_type="application/pdf",
        filename=full.name,
        headers={"Content-Disposition": f'attachment; filename="{full.name}"'},
    )


# ---------------------------------------------------------------------------
# USERDATA  —  what-you-doing/
# Stores recents, favourites, progress, settings as JSON files on disk.
# Mounted from host so data persists across container restarts and
# is accessible from any browser on the same server.
# ---------------------------------------------------------------------------
USERDATA_DIR = BASE_DIR / "what-you-doing"
USERDATA_DIR.mkdir(exist_ok=True)

USERDATA_FILES = {
    "recents":    USERDATA_DIR / "recents.json",
    "favs":       USERDATA_DIR / "favs.json",
    "progress":   USERDATA_DIR / "progress.json",
    "settings":   USERDATA_DIR / "settings.json",
    "highlights":  USERDATA_DIR / "highlights.json",
    "dupe_cache": USERDATA_DIR / "dupe_cache.json",
}

_userdata_lock = threading.Lock()

def _read_ud(key: str, default):
    try:
        f = USERDATA_FILES[key]
        if f.exists():
            return json.loads(f.read_text("utf-8"))
    except Exception:
        pass
    return default

def _write_ud(key: str, data):
    with _userdata_lock:
        try:
            USERDATA_FILES[key].write_text(json.dumps(data, ensure_ascii=False, indent=2), "utf-8")
        except Exception as e:
            print(f"[userdata] write error {key}: {e}")

class UserDataPayload(BaseModel):
    data: object

@app.get("/api/userdata/{key}")
def ud_get(key: str):
    defaults = {"recents": [], "favs": {}, "progress": {}, "settings": {"defaultZoom": 1.4}, "highlights": {}, "dupe_cache": {}}
    if key not in defaults:
        raise HTTPException(404, f"Unknown key: {key}")
    return {"key": key, "data": _read_ud(key, defaults[key])}

@app.post("/api/userdata/{key}")
def ud_set(key: str, payload: UserDataPayload):
    allowed = {"recents", "favs", "progress", "settings", "highlights", "dupe_cache"}
    if key not in allowed:
        raise HTTPException(404, f"Unknown key: {key}")
    _write_ud(key, payload.data)
    return {"ok": True}

@app.delete("/api/userdata/{key}")
def ud_clear(key: str):
    defaults = {"recents": [], "favs": {}, "progress": {}, "settings": {"defaultZoom": 1.4}, "highlights": {}, "dupe_cache": {}}
    if key not in defaults:
        raise HTTPException(404, f"Unknown key: {key}")
    _write_ud(key, defaults[key])
    return {"ok": True}

# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# EMPTY AUTHOR DIRECTORIES
# ---------------------------------------------------------------------------

@app.get("/api/library/empty-dirs")
def api_empty_dirs():
    """Find author directories that contain no PDF files."""
    if not LIBRARY_DIR.exists():
        return {"empty_dirs": [], "count": 0}
    empty = []
    for d in sorted(LIBRARY_DIR.iterdir(), key=lambda x: x.name.lower()):
        if not d.is_dir():
            continue
        if d.name == "trashed_items":
            continue
        pdf_count = len(list(d.glob("*.pdf")))
        if pdf_count == 0:
            # Count any non-PDF files too (might have other cruft)
            all_files = [f for f in d.iterdir() if f.is_file()]
            empty.append({
                "name":       d.name,
                "path":       d.relative_to(BASE_DIR).as_posix(),
                "file_count": len(all_files),
                "files":      [f.name for f in all_files[:10]],
            })
    return {"empty_dirs": empty, "count": len(empty)}


class EmptyDirRequest(BaseModel):
    paths: list[str]   # list of relative dir paths to remove

@app.delete("/api/library/empty-dirs")
def api_delete_empty_dirs(req: EmptyDirRequest):
    """Delete (or move to trash) a list of empty author directories."""
    removed, failed = [], []
    for rel in req.paths:
        try:
            full = (BASE_DIR / rel).resolve()
            full.relative_to(BASE_DIR)          # path-traversal guard
            if not full.is_dir():
                failed.append({"path": rel, "error": "Not a directory"})
                continue
            # Safety: only remove if truly empty of PDFs
            if list(full.glob("*.pdf")):
                failed.append({"path": rel, "error": "Directory still has PDFs"})
                continue
            # Move any stray files to trash first, then rmdir
            TRASH_DIR.mkdir(parents=True, exist_ok=True)
            for f in full.iterdir():
                if f.is_file():
                    shutil.move(str(f), str(TRASH_DIR / f.name))
            full.rmdir()
            removed.append(rel)
        except Exception as e:
            failed.append({"path": rel, "error": str(e)})

    invalidate_library_cache()
    return {"removed": removed, "failed": failed,
            "removed_count": len(removed), "failed_count": len(failed)}


# ---------------------------------------------------------------------------
# DUPLICATES  —  content-aware (no name matching)
#
# Two tiers only:
#
#  Tier 1 — EXACT  (BLAKE3 of full file bytes, fallback xxhash → SHA-256)
#    Byte-for-byte identical files: renamed copies, re-uploaded files, etc.
#    BLAKE3: cryptographic, parallel, 10× faster than SHA-256.
#
#  Tier 2 — NEAR-DUPLICATE  (MinHash + LSH on extracted PDF text)
#    Same content, different compression/metadata/margins.
#    Text is shingled into character 5-grams → 128-permutation MinHash →
#    LSH forest with configurable Jaccard threshold.
#    datasketch implements this exactly as used in industrial dedup systems.
# ---------------------------------------------------------------------------

def _blake3_file(path: Path) -> str:
    """BLAKE3 hash of raw file bytes. Falls back to xxhash then SHA-256."""
    try:
        import blake3
        h = blake3.blake3()
        with open(path, 'rb') as f:
            for chunk in iter(lambda: f.read(131072), b''):
                h.update(chunk)
        return 'b3:' + h.hexdigest()
    except ImportError:
        pass
    try:
        import xxhash
        h = xxhash.xxh3_128()
        with open(path, 'rb') as f:
            for chunk in iter(lambda: f.read(131072), b''):
                h.update(chunk)
        return 'xx:' + h.hexdigest()
    except ImportError:
        pass
    import hashlib
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(131072), b''):
            h.update(chunk)
    return 'sha:' + h.hexdigest()

def _extract_text(path: Path) -> str | None:
    """Extract normalised text from PDF for MinHash. Returns None if < 100 chars."""
    try:
        import pypdf
        reader = pypdf.PdfReader(str(path), strict=False)
        parts = []
        for page in reader.pages:
            try:
                t = page.extract_text()
                if t:
                    parts.append(t)
            except Exception:
                pass
        raw  = ' '.join(parts)
        norm = re.sub(r'\s+', ' ', re.sub(r'[^\w\s]', '', raw.lower())).strip()
        return norm if len(norm) >= 100 else None
    except Exception:
        return None

def _shingle(text: str, k: int = 5) -> set[str]:
    """Character k-gram shingles — language-agnostic, works on Bengali/English."""
    return {text[i:i+k] for i in range(len(text) - k + 1)}

def _build_minhash(shingles: set[str], num_perm: int = 128):
    """128-permutation MinHash signature over a shingle set."""
    from datasketch import MinHash
    m = MinHash(num_perm=num_perm)
    for s in shingles:
        m.update(s.encode('utf-8'))
    return m

@app.get("/api/duplicates")
def api_duplicates(
    jaccard:      float = 0.80,
    skip_content: bool  = False,
):
    """
    Content-aware duplicate detection. No name matching.

    Tier 1 — exact:   BLAKE3 file hash  (always runs, fast)
    Tier 2 — near-dup: MinHash+LSH Jaccard ≥ jaccard (default 0.80)
              skip_content=true skips tier 2
    """
    lib      = get_library()
    all_books = [
        {"title": bk["title"], "path": bk["path"], "author": a["author"]}
        for a in lib for bk in a["books"]
    ]

    exact_groups   = []
    near_groups    = []
    hashed_paths   = set()

    # ── Tier 1: BLAKE3 exact hash ─────────────────────────────────────
    file_hashes: dict[str, list] = {}
    for bk in all_books:
        full = BASE_DIR / bk["path"]
        if not full.exists():
            continue
        try:
            h = _blake3_file(full)
            file_hashes.setdefault(h, []).append({
                **bk,
                "size_kb": round(full.stat().st_size / 1024),
            })
        except Exception:
            pass

    for h, group in file_hashes.items():
        if len(group) > 1:
            for b in group:
                hashed_paths.add(b["path"])
            exact_groups.append({
                "reason": "exact_copy",
                "label":  "Exact duplicate (BLAKE3 match)",
                "hash":   h[:16] + "…",
                "books":  group,
            })

    # ── Tier 2: MinHash + LSH near-duplicate ──────────────────────────
    if not skip_content:
        try:
            from datasketch import MinHashLSH, MinHash

            NUM_PERM  = 128
            lsh       = MinHashLSH(threshold=jaccard, num_perm=NUM_PERM)
            minhashes: dict[str, tuple] = {}   # path → (minhash, book_meta)

            remaining = [b for b in all_books if b["path"] not in hashed_paths]

            for bk in remaining:
                full = BASE_DIR / bk["path"]
                if not full.exists():
                    continue
                text = _extract_text(full)
                if not text:
                    continue   # scanned PDF, no text layer — skip
                shingles = _shingle(text, k=5)
                if len(shingles) < 20:
                    continue
                m = MinHash(num_perm=NUM_PERM)
                for s in shingles:
                    m.update(s.encode('utf-8'))
                safe_key = bk["path"].replace('/', '__')
                try:
                    lsh.insert(safe_key, m)
                    minhashes[safe_key] = (m, bk)
                except Exception:
                    pass  # duplicate key (shouldn't happen)

            # Query LSH for each item to find its neighbours
            visited = set()
            for key, (m, bk) in minhashes.items():
                if key in visited:
                    continue
                neighbours = lsh.query(m)
                # Filter to genuine neighbours (not self)
                neighbours = [k for k in neighbours if k != key]
                if not neighbours:
                    continue
                # Build group
                group = [bk]
                visited.add(key)
                for nk in neighbours:
                    if nk in minhashes and nk not in visited:
                        group.append(minhashes[nk][1])
                        visited.add(nk)
                if len(group) > 1:
                    near_groups.append({
                        "reason":  "near_duplicate",
                        "label":   f"Near-duplicate content (Jaccard ≥ {round(jaccard*100)}%)",
                        "books":   group,
                    })

        except ImportError:
            near_groups = [{"reason": "error", "label":
                "datasketch not installed — rebuild Docker image", "books": []}]
        except Exception as e:
            near_groups = [{"reason": "error",
                "label": f"Near-dup scan error: {e}", "books": []}]

    all_book_groups = exact_groups + near_groups
    return {
        "book_groups":          all_book_groups,
        "exact_groups":         exact_groups,
        "near_groups":          near_groups,
        "total_duplicate_books": sum(len(g["books"]) for g in all_book_groups
                                     if g.get("reason") != "error"),
        "skip_content": skip_content,
        "jaccard":      jaccard,
    }

# TRASH  —  trashed_items/
# Moving to trash = rename into trashed_items/ preserving sub-path.
# Permanent delete = remove from trashed_items/.
# ---------------------------------------------------------------------------
TRASH_DIR = BASE_DIR / "bengali-literature" / "trashed_items"

@app.get("/api/trash")
def api_trash_list():
    """List everything in trashed_items/."""
    if not TRASH_DIR.exists():
        return {"items": []}
    items = []
    for f in sorted(TRASH_DIR.rglob("*.pdf"), key=lambda p: p.stat().st_mtime, reverse=True):
        items.append({
            "name":     f.name,
            "path":     f.relative_to(BASE_DIR).as_posix(),
            "size_kb":  round(f.stat().st_size / 1024),
            "trashed":  datetime.fromtimestamp(f.stat().st_mtime).strftime("%Y-%m-%d %H:%M"),
        })
    return {"items": items}

class TrashRequest(BaseModel):
    path: str   # relative to BASE_DIR

@app.post("/api/trash/move")
def api_trash_move(req: TrashRequest):
    """Move a file to trashed_items/."""
    try:
        src = (BASE_DIR / req.path).resolve()
        src.relative_to(BASE_DIR)
    except ValueError:
        raise HTTPException(400, "Invalid path")
    if not src.exists():
        raise HTTPException(404, "File not found")
    if "trashed_items" in str(src):
        raise HTTPException(400, "Already in trash")

    TRASH_DIR.mkdir(parents=True, exist_ok=True)
    dest = TRASH_DIR / src.name
    # Avoid collision
    if dest.exists():
        ts   = datetime.now().strftime("%Y%m%d_%H%M%S")
        dest = TRASH_DIR / f"{src.stem}__{ts}{src.suffix}"

    shutil.move(str(src), str(dest))
    invalidate_library_cache()
    return {"ok": True, "trashed_to": dest.relative_to(BASE_DIR).as_posix()}

@app.delete("/api/trash/delete")
def api_trash_delete(path: str):
    """Permanently delete a file from trashed_items/."""
    try:
        full = (BASE_DIR / path).resolve()
        full.relative_to(TRASH_DIR)   # must be inside trash
    except ValueError:
        raise HTTPException(400, "Path must be inside trashed_items/")
    if not full.exists():
        raise HTTPException(404, "Not found")
    full.unlink()
    return {"ok": True}

@app.delete("/api/trash/empty")
def api_trash_empty():
    """Permanently delete everything in trashed_items/."""
    if not TRASH_DIR.exists():
        return {"ok": True, "deleted": 0}
    count = 0
    for f in TRASH_DIR.rglob("*.pdf"):
        f.unlink(); count += 1
    return {"ok": True, "deleted": count}


class TrashRestoreRequest(BaseModel):
    path: str   # relative path inside trashed_items/

@app.post("/api/trash/restore")
def api_trash_restore(req: TrashRestoreRequest):
    """
    Restore a file from trashed_items/ back to bengali-literature/.
    Tries to restore to the author folder based on filename heuristics,
    falling back to the root of bengali-literature/ if uncertain.
    """
    try:
        src = (BASE_DIR / req.path).resolve()
        src.relative_to(TRASH_DIR)   # must be inside trash
    except ValueError:
        raise HTTPException(400, "Path must be inside trashed_items/")
    if not src.exists():
        raise HTTPException(404, "File not found in trash")

    # Try to figure out the original author folder.
    # Heuristic: look for an author folder whose name appears in the filename.
    stem = src.stem.lower()
    best_dir = None
    if LIBRARY_DIR.exists():
        for author_dir in LIBRARY_DIR.iterdir():
            if not author_dir.is_dir(): continue
            if author_dir.name == "trashed_items": continue
            norm = author_dir.name.lower().replace('_', ' ')
            if norm in stem or stem in norm:
                best_dir = author_dir
                break

    dest_dir = best_dir if best_dir else LIBRARY_DIR
    dest     = dest_dir / src.name

    # Avoid collision
    if dest.exists():
        ts   = datetime.now().strftime("%Y%m%d_%H%M%S")
        dest = dest_dir / f"{src.stem}__restored__{ts}{src.suffix}"

    shutil.move(str(src), str(dest))
    invalidate_library_cache()

    return {
        "ok":          True,
        "restored_to": dest.relative_to(BASE_DIR).as_posix(),
    }

# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# STATIC FILES
# ---------------------------------------------------------------------------
PDFJS_DIR = BASE_DIR / "pdfjs"

print(f"[startup] BASE_DIR      = {BASE_DIR}")
print(f"[startup] FRONTEND_DIR  = {FRONTEND_DIR}  exists={FRONTEND_DIR.exists()}")
print(f"[startup] PDFJS_DIR     = {PDFJS_DIR}      exists={PDFJS_DIR.exists()}")
print(f"[startup] USERDATA_DIR  = {USERDATA_DIR}")
print(f"[startup] TRASH_DIR     = {TRASH_DIR}")
print(f"[startup] CPU_COUNT     = {CPU_COUNT}")

if PDFJS_DIR.exists():
    app.mount("/pdfjs", StaticFiles(directory=str(PDFJS_DIR)), name="pdfjs")
    print("[startup] PDF.js mounted at /pdfjs")

if not FRONTEND_DIR.exists():
    print("[startup] WARNING: frontend missing")
else:
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
    print("[startup] Frontend mounted OK")

# ---------------------------------------------------------------------------
# ENTRYPOINT
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=7654, reload=True)
