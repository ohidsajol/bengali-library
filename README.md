# বাংলা পাঠাগার — Bengali Digital Library

> A beautiful, fully offline digital library for Bengali PDF books.  
> Runs anywhere with Docker. No cloud. No API keys. Your data stays on your machine.

![Bengali Digital Library Screenshot](https://raw.githubusercontent.com/ohidsajol/bengali-library/refs/heads/main/docs/screenshot.png)

---

## Features

| Feature | Details |
|---|---|
| **PDF Reader** | Continuous scroll, page thumbnails, text search, text selection, highlights, zoom, resume where you left off |
| **OCR** | Convert scanned PDFs to searchable text (Tesseract, Bengali + English) |
| **Library Browser** | Browse by author, A-Z filter, full-text search across all books |
| **Duplicate Detection** | BLAKE3 content hashing — finds exact byte-for-byte copies instantly |
| **Themes** | 6 themes: Parchment, Dark, Ocean, Forest, Slate, Rose |
| **Recents & Favourites** | Persisted across browsers and machines |
| **Trash** | Move to trash → restore or permanently delete |
| **Empty Folder Cleanup** | Find and remove empty author directories |
| **Server-side Data** | All user data stored in `~/.bengali_library_docker/data/` — portable and private |

---

## Requirements

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Windows / macOS) or [Docker Engine](https://docs.docker.com/engine/install/) (Linux)
- ~2 GB free disk space (for the Docker image)
- Your PDF files, organised as `Author Name/Book Title.pdf`

---

## Quick Start

### Linux / macOS

```bash
# Install (one-time)
curl -fsSL https://raw.githubusercontent.com/ohidsajol/bengali-library/refs/heads/main/install.sh | bash

# Start the library
bengali-library
```

### Windows (PowerShell)

```powershell
# Allow scripts (one-time, run as Administrator)
Set-ExecutionPolicy RemoteSigned -Scope CurrentUser -Force

# Install (one-time)
irm https://raw.githubusercontent.com/ohidsajol/bengali-library/refs/heads/main/install.ps1 | iex

# Start the library (new terminal)
bengali-library
```

On first run you will be asked where your PDF library is. The app then opens at **http://localhost:7654**.

---

## Library Structure

Organise your PDFs like this:

```
/path/to/your/library/
├── Rabindranath Tagore/
│   ├── Gitanjali.pdf
│   ├── Ghare Baire.pdf
│   └── Chokher Bali.pdf
├── Kazi Nazrul Islam/
│   ├── Agnibeena.pdf
│   └── Sanchita.pdf
└── Sarat Chandra Chattopadhyay/
    └── Devdas.pdf
```

The app auto-discovers all PDFs. Add new books and click **Settings → Refresh**.

---

## Commands

### Linux / macOS

| Command | Description |
|---|---|
| `bengali-library` | Start the app and open in browser |
| `bengali-library --stop` | Stop the container |
| `bengali-library --logs` | Tail live logs |
| `bengali-library --status` | Show container info, library path, PDF count |
| `bengali-library --update` | Pull the latest Docker image |
| `bengali-library --set-library /path` | Change the library directory |
| `bengali-library --clean` | Remove container + user data (PDFs untouched) |

### Windows (PowerShell)

| Command | Description |
|---|---|
| `bengali-library` | Start the app |
| `bengali-library -Stop` | Stop |
| `bengali-library -Logs` | Tail logs |
| `bengali-library -Status` | Show info |
| `bengali-library -Update` | Update image |
| `bengali-library -SetLibrary "C:\path"` | Change library path |
| `bengali-library -Clean` | Remove data |

---

## Data & Privacy

All user data is stored on **your machine** in `~/.bengali_library_docker/`:

```
~/.bengali_library_docker/
├── library_directory.txt    ← path to your PDF library
├── data/
│   ├── recents.json         ← recently read books
│   ├── favs.json            ← favourites
│   ├── progress.json        ← reading progress (page number per book)
│   ├── highlights.json      ← text highlights
│   ├── settings.json        ← theme, zoom
│   └── dupe_cache.json      ← last duplicate scan result
└── ocr/
    └── *.pdf                ← OCR output files
```

- Nothing is sent to any server. The app runs 100% offline after the Docker image is downloaded.
- To share the app with someone else: give them the Docker image. **Do not share** `~/.bengali_library_docker/data/` — that is your personal reading history.
- OCR files in `~/.bengali_library_docker/ocr/` can be large. Safe to delete if you need space; they will be regenerated on demand.

---

## PDF Reader — Keyboard Shortcuts

| Key | Action |
|---|---|
| `↑` `↓` `Page Up` `Page Down` | Scroll / change page |
| `Home` / `End` | First / last page |
| `+` / `-` | Zoom in / out |
| `T` | Toggle thumbnail sidebar |
| `Ctrl+F` | Search text in document |
| `Esc` | Close search |

**Text selection:** Select any text with the cursor. A toolbar appears:
- **Highlight** — draws a persistent yellow highlight (saved in `highlights.json`)
- **Search** — opens Google with the selected text in a new tab

**Resume reading:** A "📌 Resume p.N" button appears in the reader toolbar if you have a saved position. A banner also appears at the bottom when you first open a book mid-way through.

---

## OCR

Click **OCR** on any book to make it text-searchable. This:

1. Runs the PDF through OCRmyPDF + Tesseract (Bengali + English)
2. Replaces the original file with the OCR'd version in-place
3. Names it `BookTitle__ocred__TIMESTAMP.pdf`
4. The library refreshes automatically

OCR can take 1–5 minutes for a large book. A live progress bar shows current status. Click **Cancel** to abort without touching the original file.

---

## Duplicate Detection

Go to **Settings → Duplicates** or the home page **⚠ Duplicates** button.

- Uses **BLAKE3** cryptographic hashing — reads each file and computes a 256-bit hash
- Groups files with identical hashes (byte-for-byte copies)
- Each group shows which file to **Keep** (first) and which are **Duplicates**
- Click **Trash all duplicates** to move all non-first copies to trash in one click
- Results are cached with timestamp — you don't need to re-scan every time
- Click **✕ Cancel** at any time to stop a scan in progress

---

## Themes

Click **🎨 Theme** in the top bar or go to **Settings → Theme**:

| Theme | Colours |
|---|---|
| 📜 Parchment | Warm off-white, terracotta accent (default) |
| 🌑 Dark | Deep brown-black, warm amber |
| 🌊 Ocean | Cool blue, sky accent |
| 🌲 Forest | Sage green, forest accent |
| 🪨 Slate | Dark slate blue, ice accent |
| 🌹 Rose | Blush pink, rose accent |

---

## Building from Source

```bash
git clone https://github.com/ohidsajol/bengali-library.git
cd bengali-library

# Build the image locally
docker build -t bengali-library:local .

# Run locally
docker run -d \
  --name bengali-library \
  -p 7654:7654 \
  -v /path/to/your/pdfs:/app/bengali-literature:rw \
  -v "$HOME/.bengali_library_docker/data:/app/what-you-doing:rw" \
  -v "$HOME/.bengali_library_docker/ocr:/app/ocr:rw" \
  bengali-library:local
```

---

## Publishing Your Own Image

```bash
# Build
docker build -t ohidsajol/bengali-library:latest .

# Tag with version
docker tag ohidsajol/bengali-library:latest ohidsajol/bengali-library:v2.0.0

# Push to Docker Hub (requires docker login)
docker login
docker push ohidsajol/bengali-library:latest
docker push ohidsajol/bengali-library:v2.0.0
```

Then update `IMAGE=` in `run.sh` and `run.ps1` with your Docker Hub username.

---

## Project Structure

```
bengali-library/
├── backend/
│   ├── main.py           FastAPI server (24 routes)
│   └── requirements.txt
├── frontend/
│   ├── index.html        SPA shell + theme switcher
│   ├── style.css         6 themes, all components
│   ├── app.js            SPA router + all page logic
│   └── reader.html       Self-contained PDF reader
├── Dockerfile            Single-container production image
├── docker-compose.yml    For local development
├── run.sh                Linux/macOS management script
├── run.ps1               Windows management script
├── install.sh            Linux/macOS one-command installer
├── install.ps1           Windows one-command installer
└── README.md
```

---

## Troubleshooting

**App doesn't open / localhost refused**
```bash
bengali-library --status   # check if container is running
bengali-library --logs     # see error messages
bengali-library --stop && bengali-library  # restart
```

**OCR fails**
- Make sure the PDF is not password-protected
- Very large PDFs (500+ pages) may time out — try a smaller section

**Duplicate scan is slow**
- Click **✕ Cancel** at any time — the original library is untouched
- Results are cached after completion

**Highlights disappeared**
- Highlights are stored in `~/.bengali_library_docker/data/highlights.json`
- Clicking **💾 Save** in the reader burns them permanently into the PDF file

**Port 7654 already in use**
- Edit `run.sh` (or `run.ps1`) and change `PORT=7654` to any free port

**Update the app**
```bash
bengali-library --update
bengali-library --stop && bengali-library
```

---

## License

MIT License — free to use, modify, and distribute.

---

## Acknowledgements

- [FastAPI](https://fastapi.tiangolo.com/) — Python web framework
- [PDF.js](https://mozilla.github.io/pdf.js/) — PDF rendering in the browser
- [OCRmyPDF](https://ocrmypdf.readthedocs.io/) — OCR engine
- [Tesseract](https://github.com/tesseract-ocr/tesseract) — Bengali OCR model
- [BLAKE3](https://github.com/BLAKE3-team/BLAKE3) — Cryptographic hashing
- [Lora](https://fonts.google.com/specimen/Lora) + [Noto Serif Bengali](https://fonts.google.com/noto/specimen/Noto+Serif+Bengali) — Typography
