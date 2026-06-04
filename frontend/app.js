/**
 * app.js — Bengali Digital Library Frontend
 * ══════════════════════════════════════════════
 * Pure vanilla JS SPA.
 * All data comes from the FastAPI backend at /api/*
 * PDFs are served from /pdf/<path>
 * OCR progress is streamed via Server-Sent Events.
 */
'use strict';

const API = '';   // same origin — backend serves frontend too

/* ══════════════════════════════════════════════
   API HELPERS
   ══════════════════════════════════════════════ */

async function apiFetch(url, opts = {}) {
  const res = await fetch(API + url, opts);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

function pdfUrl(path) {
  return `${API}/pdf/${encodeURIPath(path)}`;
}

function encodeURIPath(p) {
  return p.split('/').map(encodeURIComponent).join('/');
}

/* ══════════════════════════════════════════════
   SERVER-BACKED PERSISTENCE  (what-you-doing/)
   ══════════════════════════════════════════════
   All user data (recents, favs, progress, settings)
   is stored on the server — not in localStorage.
   This means every browser, every device, same data.
   localStorage is used only as a write-through cache
   to make reads instant.
   ══════════════════════════════════════════════ */

const DB = {
  // ── local cache ─────────────────────────────
  _mem: {},
  _defaults: {
    recents:  [],
    favs:     {},
    progress: {},
    settings: { defaultZoom: 1.4 },
  },

  // Read from cache (populated on boot)
  _get(key) { return this._mem[key] ?? this._defaults[key]; },

  // Write to cache + persist to server
  async _set(key, val) {
    this._mem[key] = val;
    // fire-and-forget; errors are non-fatal
    apiFetch(`/api/userdata/${key}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ data: val }),
    }).catch(() => {});
  },

  // Load all keys from server into cache
  async loadAll() {
    for (const key of Object.keys(this._defaults)) {
      try {
        const r = await apiFetch(`/api/userdata/${key}`);
        this._mem[key] = r.data ?? this._defaults[key];
      } catch {
        this._mem[key] = this._defaults[key];
      }
    }
  },

  // Recents
  getRecents() { return this._get('recents'); },
  addRecent(book, authorName) {
    let l = this.getRecents().filter(r => r.path !== book.path);
    l.unshift({ path: book.path, title: book.title, author: authorName, ts: Date.now() });
    this._set('recents', l.slice(0, 50));
  },
  async clearRecents() { await this._set('recents', []); },

  // Favourites
  getFavs()     { return this._get('favs'); },
  isFav(path)   { return !!this.getFavs()[path]; },
  async toggleFav(book, authorName) {
    const f = { ...this.getFavs() };
    if (f[book.path]) delete f[book.path];
    else f[book.path] = { path: book.path, title: book.title, author: authorName };
    await this._set('favs', f);
    return !!f[book.path];
  },

  // Reading progress
  getProgress(path) { return (this._get('progress'))[path] || null; },
  setProgress(path, page, total) {
    const p = { ...this._get('progress') };
    p[path] = { page, total, ts: Date.now() };
    this._set('progress', p);
  },
  async clearProgress() { await this._set('progress', {}); },

  // Settings
  getSettings()      { return this._get('settings'); },
  async saveSettings(s) { await this._set('settings', { ...this.getSettings(), ...s }); },
};

/* ══════════════════════════════════════════════
   LIBRARY STATE
   ══════════════════════════════════════════════ */

let _library   = [];
let _libLoaded = false;

async function loadLibrary(force = false) {
  if (_libLoaded && !force) return _library;
  const data = await apiFetch(force ? '/api/library/refresh' : '/api/library');
  _library   = data.library || [];
  _libLoaded = true;
  return _library;
}

function getStats() {
  return {
    authors: _library.length,
    books:   _library.reduce((n, a) => n + a.books.length, 0),
  };
}

function findByPath(path) {
  for (const author of _library)
    for (const book of author.books)
      if (book.path === path) return { book, author };
  return null;
}

/* ══════════════════════════════════════════════
   ROUTER
   ══════════════════════════════════════════════ */

const navHistory = [];
let   navIdx     = -1;

const content = document.getElementById('content');
const btnBack = document.getElementById('btn-back');
const btnFwd  = document.getElementById('btn-forward');

function navigate(renderFn, label = '') {
  if (navIdx < navHistory.length - 1) navHistory.splice(navIdx + 1);
  navHistory.push({ render: renderFn, label });
  navIdx = navHistory.length - 1;
  _exec();
}

function goBack()    { if (navIdx > 0)                      { navIdx--; _exec(); } }
function goForward() { if (navIdx < navHistory.length - 1) { navIdx++; _exec(); } }

function _exec() {
  _syncBtns();
  closeReader();
  const e = navHistory[navIdx];
  if (!e) return;
  content.innerHTML = '';
  e.render();
  content.scrollTop = 0;
  const first = content.firstElementChild;
  if (first) first.classList.add('page-enter');
}

function _syncBtns() {
  btnBack.disabled = navIdx <= 0;
  btnFwd.disabled  = navIdx >= navHistory.length - 1;
}

btnBack.addEventListener('click', goBack);
btnFwd .addEventListener('click', goForward);
document.getElementById('btn-home')    .addEventListener('click', () => navigate(renderHome,     'Home'));
document.getElementById('nav-recents') .addEventListener('click', () => navigate(renderRecents,  'Recents'));
document.getElementById('nav-favs')    .addEventListener('click', () => navigate(renderFavs,     'Favourites'));
document.getElementById('nav-settings').addEventListener('click', () => navigate(renderSettings, 'Settings'));

/* ══════════════════════════════════════════════
   TOAST
   ══════════════════════════════════════════════ */

let _toastWrap = null;
function toast(msg, type = 'info', ms = 3500) {
  if (!_toastWrap) {
    _toastWrap = document.createElement('div');
    _toastWrap.className = 'toast-wrap';
    document.body.appendChild(_toastWrap);
  }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  _toastWrap.appendChild(el);
  setTimeout(() => {
    el.style.animation = 'toastOut .28s ease forwards';
    setTimeout(() => el.remove(), 300);
  }, ms);
}

/* ══════════════════════════════════════════════════════════════
   PDF READER  v4  —  PDF.js prebuilt viewer inside an iframe
   ─────────────────────────────────────────────────────────────
   Uses the full PDF.js web viewer (downloaded into /pdfjs at
   build time).  Gives you for free:
     • Continuous scroll                 • Page thumbnails
     • Full text search  (Ctrl+F)        • Zoom / fit-page
     • Text selection + copy             • Print
     • Dark / light mode toggle          • Document outline
     • Annotation layer (built-in)
   ══════════════════════════════════════════════════════════════ */

let _readerEl = null;  // kept for compatibility
let _rPath    = '';

// openReader — opens reader.html in a NEW TAB and immediately focuses it
function openReader(bookPath, title = '', startPage = 1) {
  const found = findByPath(bookPath);
  if (found) DB.addRecent(found.book, found.author.author);

  if (startPage <= 1) {
    const prog = DB.getProgress(bookPath);
    if (prog && prog.page > 1) startPage = prog.page;
  }

  const fileUrl = `${location.origin}/pdf/${bookPath.split('/').map(encodeURIComponent).join('/')}`;
  const params  = new URLSearchParams({
    file:  fileUrl,
    path:  bookPath,
    title: encodeURIComponent(title),
    page:  startPage,
  });
  const tab = window.open(`/reader.html?${params}`, '_blank');
  if (tab) tab.focus();
}

function closeReader() {}

/* ══════════════════════════════════════════════
   OCR  (SSE progress stream)
   ══════════════════════════════════════════════ */

async function runOcr(book, authorName) {
  // Already OCRed? (detected from __ocred__ in filename)
  if (book.already_ocred) {
    toast('এই ফাইলটি ইতিমধ্যে OCR করা হয়েছে।', 'info');
    DB.addRecent(book, authorName);
    openReader(book.path, book.title);
    return;
  }

  // Build overlay with cancel button
  const overlay = document.createElement('div');
  overlay.className = 'ocr-overlay';
  overlay.innerHTML = `
    <div class="ocr-card">
      <div class="ocr-spinner" id="ocr-spinner"></div>
      <div class="ocr-title">OCR চলছে…</div>
      <div class="ocr-bar-wrap"><div class="ocr-bar" id="ocr-bar" style="width:0%"></div></div>
      <div class="ocr-msg" id="ocr-msg">প্রস্তুত হচ্ছে…</div>
      <div class="ocr-book">${esc(book.title)}</div>
      <button class="btn btn-ghost btn-sm" id="ocr-cancel-btn"
        style="margin-top:18px;color:#e05555;border-color:#e05555;">
        ✕ বাতিল করুন
      </button>
    </div>`;
  document.body.appendChild(overlay);

  let currentJobId = null;
  let cancelled    = false;

  const setMsg = (m, pct) => {
    const el = document.getElementById('ocr-msg');
    const br = document.getElementById('ocr-bar');
    if (el) el.textContent = m;
    if (br) br.style.width = pct + '%';
  };

  overlay.querySelector('#ocr-cancel-btn').addEventListener('click', async () => {
    cancelled = true;
    setMsg('বাতিল হচ্ছে…', 0);
    overlay.querySelector('#ocr-cancel-btn').disabled = true;
    if (currentJobId) {
      try { await fetch(`/api/ocr/cancel/${currentJobId}`, { method: 'POST' }); } catch {}
    }
  });

  try {
    const job = await apiFetch('/api/ocr', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ book_path: book.path, language: 'ben+eng' }),
    });

    // Server says file is already OCRed
    if (job.status === 'already_ocred') {
      overlay.remove();
      toast('এই ফাইলটি ইতিমধ্যে OCR করা হয়েছে।', 'info');
      await loadLibrary(true); rebuildIndex();
      if (navHistory[navIdx]) navHistory[navIdx].render();
      openReader(job.output_path, book.title);
      return;
    }

    currentJobId = job.job_id;
    const es = new EventSource(`${API}/api/ocr/events/${job.job_id}`);

    await new Promise((resolve, reject) => {
      es.onmessage = async (e) => {
        const d = JSON.parse(e.data);
        setMsg(d.message || '', d.progress || 0);

        if (d.status === 'done') {
          es.close();
          overlay.remove();
          // Refresh library — original file was replaced on disk
          await loadLibrary(true);
          rebuildIndex();
          if (navHistory[navIdx]) navHistory[navIdx].render();
          toast(`OCR সম্পন্ন! ${d.pages ? d.pages + ' পেজ · ' : ''}ফাইল প্রতিস্থাপিত হয়েছে।`, 'success', 6000);
          DB.addRecent({ ...book, path: d.output_path }, authorName);
          openReader(d.output_path, book.title + ' (OCR)');
          resolve();

        } else if (d.status === 'cancelled') {
          es.close();
          overlay.remove();
          toast('OCR বাতিল হয়েছে। মূল ফাইল অপরিবর্তিত।', 'info', 4000);
          resolve();

        } else if (d.status === 'error') {
          es.close();
          overlay.remove();
          toast('OCR ব্যর্থ: ' + (d.error || d.message), 'error', 7000);
          reject(new Error(d.error || d.message));
        }
      };
      es.onerror = () => {
        es.close();
        if (!cancelled) { overlay.remove(); toast('OCR সংযোগ বিচ্ছিন্ন হয়েছে।', 'error'); }
        reject(new Error('SSE lost'));
      };
    });

  } catch (err) {
    if (overlay.parentNode) overlay.remove();
    const msg = err.message || '';
    if (msg !== 'SSE lost' && !cancelled) toast('OCR ত্রুটি: ' + msg, 'error');
  }
}


/* ══════════════════════════════════════════════
   DOWNLOAD
   ══════════════════════════════════════════════ */

function downloadBook(path, name) {
  const a = document.createElement('a');
  a.href     = `${API}/api/download?path=${encodeURIComponent(path)}`;
  a.download = name;
  a.click();
}

/* ══════════════════════════════════════════════
   SEARCH  — full-page results, persisted in nav
   ══════════════════════════════════════════════ */

const searchInput    = document.getElementById('search-input');
// Keep the dropdown element in DOM but we never use it as dropdown anymore
const searchDropdown = document.getElementById('search-results');

let _searchIdx   = [];
let _lastQuery   = '';      // persists current search query across navigation

function buildIndex() {
  const idx = [];
  _library.forEach(author => {
    idx.push({ type: 'author', label: author.author, authorObj: author });
    author.books.forEach(book => {
      idx.push({ type: 'book', label: book.title, book, authorObj: author });
    });
  });
  return idx;
}

function rebuildIndex() { _searchIdx = buildIndex(); }

function doSearch(q) {
  if (!q.trim()) return [];
  const lq = q.toLowerCase();
  return _searchIdx.filter(r => r.label.toLowerCase().includes(lq));
}

// Debounce timer for search input
let _searchTimer = null;

searchInput.addEventListener('input', () => {
  clearTimeout(_searchTimer);
  const q = searchInput.value;
  _lastQuery = q;
  if (!q.trim()) {
    // Empty search → go home if we're currently on a search page
    if (navHistory[navIdx]?.label === 'Search') navigate(renderHome, 'Home');
    return;
  }
  _searchTimer = setTimeout(() => {
    // Navigate to search page (or replace current if already on search page)
    const query = q.trim();
    if (navHistory[navIdx]?.label === 'Search') {
      // Replace in-place so search stays as one history entry
      navHistory[navIdx] = { render: () => renderSearch(query), label: 'Search' };
      content.innerHTML = '';
      renderSearch(query);
    } else {
      navigate(() => renderSearch(query), 'Search');
    }
  }, 200);
});

searchInput.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    searchInput.value = '';
    _lastQuery = '';
    searchInput.blur();
    if (navHistory[navIdx]?.label === 'Search') goBack();
  }
  if (e.key === 'Enter') {
    clearTimeout(_searchTimer);
    const q = searchInput.value.trim();
    if (!q) return;
    _lastQuery = q;
    if (navHistory[navIdx]?.label === 'Search') {
      navHistory[navIdx] = { render: () => renderSearch(q), label: 'Search' };
      content.innerHTML = '';
      renderSearch(q);
    } else {
      navigate(() => renderSearch(q), 'Search');
    }
  }
});

/* ══════════════════════════════════════════════
   UTILITIES
   ══════════════════════════════════════════════ */

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function initial(s) { return String(s ?? '').trim()[0] ?? '?'; }
function rand(arr)  { return arr[Math.floor(Math.random() * arr.length)]; }
function fmtDate(ts){ try { return new Date(ts).toLocaleDateString('bn-BD',{day:'numeric',month:'short',year:'numeric'}); } catch { return ''; } }

/* ══════════════════════════════════════════════
   BOOK CARD
   ══════════════════════════════════════════════ */

function buildBookCard(book, author, opts = {}) {
  const isFav     = DB.isFav(book.path);
  const prog      = DB.getProgress(book.path);
  const isOcred   = !!book.already_ocred;
  const card      = document.createElement('div');
  card.className  = 'book-card';

  let progHtml = '';
  if (prog && prog.total > 0) {
    const pct = Math.round((prog.page / prog.total) * 100);
    progHtml = `<div class="progress-wrap" title="${prog.page}/${prog.total} পেজ">
      <div class="progress-bar" style="width:${pct}%"></div></div>`;
  }

  // OCR badge shown when filename contains __ocred__
  const ocrBadge = isOcred
    ? `<span class="ocr-badge" title="এই ফাইলটি OCR করা হয়েছে">✓ OCRed</span>`
    : '';

  // OCR button: if already ocred, show disabled badge-style button
  const ocrBtnHtml = isOcred
    ? `<button class="btn btn-ghost btn-sm ocr-done-btn" disabled title="ইতিমধ্যে OCR করা হয়েছে">✓ OCRed</button>`
    : `<button class="btn btn-ghost btn-sm">OCR</button>`;

  card.innerHTML = `
    <div class="book-card-top">
      <div class="book-spine${isOcred ? ' spine-ocred' : ''}"></div>
      <div class="book-info">
        <div class="book-title">${esc(book.title)}</div>
        ${ocrBadge}
        ${opts.hideAuthor ? '' : `<div class="book-author-link">${esc(author.author)}</div>`}
      </div>
      <button class="fav-btn${isFav ? ' active' : ''}">${isFav ? '♥' : '♡'}</button>
    </div>
    ${progHtml}
    <div class="book-actions">
      <button class="btn btn-primary  btn-sm">📖 পড়ুন</button>
      <button class="btn btn-secondary btn-sm" title="ডাউনলোড">⬇</button>
      ${ocrBtnHtml}
    </div>`;

  const readBtn  = card.querySelector('.btn-primary');
  const dlBtn    = card.querySelector('.btn-secondary');
  const ocrBtn   = card.querySelector('.book-actions .btn-ghost');
  const favBtn   = card.querySelector('.fav-btn');
  const titleEl  = card.querySelector('.book-title');
  const authorEl = card.querySelector('.book-author-link');

  titleEl.addEventListener('click', () => navigate(() => renderBook(book, author), book.title));
  authorEl && authorEl.addEventListener('click', e => {
    e.stopPropagation();
    navigate(() => renderAuthor(author), author.author);
  });

  favBtn.addEventListener('click', e => {
    e.stopPropagation();
    const added = DB.toggleFav(book, author.author);
    favBtn.textContent = added ? '♥' : '♡';
    favBtn.classList.toggle('active', added);
    toast(added ? 'পছন্দতালিকায় যোগ হয়েছে ♥' : 'সরানো হয়েছে', added ? 'success' : 'info');
  });

  readBtn.addEventListener('click', e => {
    e.stopPropagation();
    DB.addRecent(book, author.author);
    const p = DB.getProgress(book.path);
    openReader(book.path, book.title, p ? p.page : 1);
  });

  dlBtn.addEventListener('click', e => {
    e.stopPropagation();
    downloadBook(book.path, book.title + '.pdf');
  });

  if (ocrBtn && !isOcred) {
    ocrBtn.addEventListener('click', e => {
      e.stopPropagation();
      runOcr(book, author.author);
    });
  }

  return card;
}


/* ══════════════════════════════════════════════
   PAGES
   ══════════════════════════════════════════════ */

/* ── Loading placeholder ── */
function showLoading(msg = 'লোড হচ্ছে…') {
  content.innerHTML = `<div class="spinner-wrap">
    <div class="spinner"></div>
    <span class="spinner-label">${esc(msg)}</span>
  </div>`;
}

/* ── SEARCH RESULTS PAGE ── */
function renderSearch(query) {
  _lastQuery = query;
  // Keep search input in sync
  if (searchInput.value !== query) searchInput.value = query;

  const results  = doSearch(query);
  const authors  = results.filter(r => r.type === 'author');
  const books    = results.filter(r => r.type === 'book');
  const total    = results.length;

  const div = document.createElement('div');
  div.innerHTML = `
    <div class="section-header">
      <h2 class="section-title">🔍 "${esc(query)}"</h2>
      <span class="section-count">${total} টি ফলাফল</span>
    </div>
    ${!total ? `<div class="empty-state">
      <span class="empty-icon">🔍</span>
      <div class="empty-text">কোনো ফলাফল পাওয়া যায়নি।</div>
      <div class="empty-sub">ভিন্ন শব্দ দিয়ে আবার চেষ্টা করুন।</div>
    </div>` : ''}
    ${authors.length ? `
    <div class="section-header" style="margin-top:${total ? '28px' : '0'}">
      <h3 class="section-title" style="font-size:1.1rem">লেখক</h3>
      <span class="section-count">${authors.length} জন</span>
    </div>
    <div class="authors-grid" id="sr-authors"></div>` : ''}
    ${books.length ? `
    <div class="section-header" style="margin-top:24px">
      <h3 class="section-title" style="font-size:1.1rem">বই</h3>
      <span class="section-count">${books.length} টি</span>
    </div>
    <div class="books-grid" id="sr-books"></div>` : ''}`;

  content.innerHTML = '';
  content.appendChild(div);
  div.classList.add('page-enter');

  // Render author cards
  if (authors.length) {
    const ag = div.querySelector('#sr-authors');
    authors.forEach(r => {
      const card = document.createElement('div');
      card.className = 'author-card';
      card.innerHTML = `
        <div class="author-initial">${esc(initial(r.authorObj.author))}</div>
        <div class="author-name">${esc(r.authorObj.author)}</div>
        <div class="author-count">${r.authorObj.books.length} টি বই</div>`;
      card.addEventListener('click', () =>
        navigate(() => renderAuthor(r.authorObj), r.authorObj.author));
      ag.appendChild(card);
    });
  }

  // Render book cards
  if (books.length) {
    const bg = div.querySelector('#sr-books');
    books.forEach(r => bg.appendChild(buildBookCard(r.book, r.authorObj)));
  }
}

/* ── HOME ── */
async function renderHome() {
  showLoading('লাইব্রেরি লোড হচ্ছে…');
  await loadLibrary();
  rebuildIndex();
  const { authors, books } = getStats();
  const recents   = DB.getRecents().slice(0, 4);
  const favCount  = Object.keys(DB.getFavs()).length;

  const div = document.createElement('div');
  div.innerHTML = `
    <div class="home-hero">
      <span class="home-ornament">📚</span>
      <h1 class="home-title">বাংলা পাঠাগার</h1>
      <p class="home-subtitle">Bengali Digital Archive · Offline Library</p>
      <div class="home-stats">
        <div class="stat-item"><span class="stat-number">${authors}</span><span class="stat-label">লেখক</span></div>
        <div class="stat-item"><span class="stat-number">${books}</span><span class="stat-label">বই</span></div>
        <div class="stat-item"><span class="stat-number">${favCount}</span><span class="stat-label">পছন্দ</span></div>
      </div>
      <div class="home-divider"></div>
      <div class="home-actions">
        <button class="btn btn-primary"   id="h-browse">📖 লেখক ব্রাউজ</button>
        <button class="btn btn-secondary" id="h-random">🎲 এলোমেলো বই</button>
        <button class="btn btn-secondary" id="h-recents">🕐 সাম্প্রতিক</button>
        <button class="btn btn-secondary" id="h-favs">♥ পছন্দ</button>
        <button class="btn btn-secondary" id="h-dupes">⚠ ডুপ্লিকেট</button>
        <button class="btn btn-secondary" id="h-trash">🗑 ট্র্যাশ</button>
      </div>
    </div>
    ${recents.length ? `
    <div class="section-header" style="margin-top:36px;">
      <h2 class="section-title">সাম্প্রতিক</h2>
      <span class="section-count">সর্বশেষ পড়া বই</span>
    </div>
    <div class="books-grid" id="home-recent-grid"></div>` : ''}`;

  content.innerHTML = '';
  content.appendChild(div);

  div.querySelector('#h-browse') .addEventListener('click', () => navigate(renderAuthors,    'Authors'));
  div.querySelector('#h-random') .addEventListener('click', () => navigate(renderRandom,     'Random'));
  div.querySelector('#h-recents').addEventListener('click', () => navigate(renderRecents,    'Recents'));
  div.querySelector('#h-favs')   .addEventListener('click', () => navigate(renderFavs,       'Favourites'));
  div.querySelector('#h-dupes')  .addEventListener('click', () => navigate(renderDuplicates, 'Duplicates'));
  div.querySelector('#h-trash')  .addEventListener('click', () => navigate(renderTrash,      'Trash'));

  if (recents.length) {
    const grid = div.querySelector('#home-recent-grid');
    recents.forEach(r => {
      const found = findByPath(r.path);
      if (found) grid.appendChild(buildBookCard(found.book, found.author));
    });
  }
}

/* ── AUTHORS ── */
async function renderAuthors() {
  showLoading();
  await loadLibrary();
  if (!_library.length) {
    content.innerHTML = `<div class="empty-state"><span class="empty-icon">📂</span>
      <div class="empty-text">লাইব্রেরি খালি।</div>
      <div class="empty-sub">bengali-literature/ ফোল্ডারে PDF যোগ করুন।</div></div>`;
    return;
  }
  const letters = [...new Set(_library.map(a => {
    const c = (a.author || ' ')[0];
    return /[a-zA-Z]/.test(c) ? c.toUpperCase() : '#';
  }))].sort();

  const div = document.createElement('div');
  div.innerHTML = `
    <div class="section-header">
      <h2 class="section-title">সকল লেখক</h2>
      <span class="section-count">${_library.length} জন</span>
    </div>
    <div class="alpha-filter">
      <button class="alpha-btn active" data-l="all">সব</button>
      ${letters.map(l => `<button class="alpha-btn" data-l="${esc(l)}">${esc(l)}</button>`).join('')}
    </div>
    <div class="authors-grid" id="ag"></div>`;
  content.innerHTML = '';
  content.appendChild(div);
  const grid = div.querySelector('#ag');

  function renderGrid(letter) {
    grid.innerHTML = '';
    const list = letter === 'all' ? _library : _library.filter(a => {
      const c = (a.author||' ')[0];
      return (/[a-zA-Z]/.test(c) ? c.toUpperCase() : '#') === letter;
    });
    if (!list.length) {
      grid.innerHTML = `<div class="empty-state" style="padding:40px 0">
        <span class="empty-icon">🔍</span><div class="empty-text">কোনো লেখক নেই।</div></div>`;
      return;
    }
    list.forEach(author => {
      const card = document.createElement('div');
      card.className = 'author-card';
      card.innerHTML = `
        <div class="author-initial">${esc(initial(author.author))}</div>
        <div class="author-name">${esc(author.author)}</div>
        <div class="author-count">${author.books.length} টি বই</div>`;
      card.addEventListener('click', () => navigate(() => renderAuthor(author), author.author));
      grid.appendChild(card);
    });
  }
  renderGrid('all');
  div.querySelector('.alpha-filter').addEventListener('click', e => {
    const btn = e.target.closest('.alpha-btn');
    if (!btn) return;
    div.querySelectorAll('.alpha-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderGrid(btn.dataset.l);
  });
}

/* ── AUTHOR DETAIL ── */
function renderAuthor(author) {
  const div = document.createElement('div');
  div.innerHTML = `
    <div class="author-hero">
      <div class="author-hero-initial">${esc(initial(author.author))}</div>
      <div>
        <div class="author-hero-name">${esc(author.author)}</div>
        <div class="author-hero-meta">${author.books.length} টি বই · বাংলা পাঠাগার</div>
      </div>
    </div>
    <div class="section-header">
      <h2 class="section-title">বইসমূহ</h2>
      <span class="section-count">${author.books.length} টি</span>
    </div>
    <div class="books-grid" id="bg"></div>`;
  content.innerHTML = '';
  content.appendChild(div);
  const grid = div.querySelector('#bg');
  author.books.forEach(book => grid.appendChild(buildBookCard(book, author, { hideAuthor: true })));
}

/* ── BOOK DETAIL ── */
function renderBook(book, author) {
  const isFav   = DB.isFav(book.path);
  const isOcred = !!book.already_ocred;
  const prog    = DB.getProgress(book.path);

  const progHtml = prog
    ? `<div class="book-detail-progress">
         <div class="book-detail-progress-bar" style="width:${Math.round(prog.page/prog.total*100)}%"></div>
         <div class="book-detail-progress-label">${prog.page} / ${prog.total} পেজ · ${Math.round(prog.page/prog.total*100)}% পড়া হয়েছে</div>
       </div>` : '';

  const ocrBtnHtml = isOcred
    ? `<button class="btn btn-ghost ocr-done-btn" disabled>✓ File is already OCRed</button>`
    : `<button class="btn btn-ghost" id="bd-ocr">🔍 OCR</button>`;

  const div = document.createElement('div');
  div.innerHTML = `
    <div class="book-detail-hero">
      <div class="book-detail-cover${isOcred ? ' cover-ocred' : ''}"></div>
      <div class="book-detail-info">
        <div class="book-detail-title" id="bd-title">${esc(book.title)}</div>
        <div class="book-detail-author" id="bd-author">✍ ${esc(author.author)}</div>
        ${isOcred ? `<div class="ocr-badge-detail">✓ File is already OCRed — text is searchable</div>` : ''}
        ${progHtml}
        <div class="book-detail-actions">
          <button class="btn btn-primary"   id="bd-read">📖 পড়ুন</button>
          <button class="btn btn-secondary" id="bd-dl">⬇ ডাউনলোড</button>
          ${ocrBtnHtml}
          <button class="btn btn-ghost ${isFav ? 'fav-active' : ''}" id="bd-fav">${isFav ? '♥ পছন্দ' : '♡ পছন্দ'}</button>
          <button class="btn btn-ghost btn-sm" id="bd-trash" style="color:#e05555;border-color:#e05555;">🗑 Trash</button>
        </div>
      </div>
    </div>
    <div class="book-path-label">📁 ${esc(book.path)}</div>`;

  content.innerHTML = '';
  content.appendChild(div);

  div.querySelector('#bd-title') .addEventListener('click', () => { DB.addRecent(book,author.author); openReader(book.path,book.title); });
  div.querySelector('#bd-author').addEventListener('click', () => navigate(() => renderAuthor(author), author.author));
  div.querySelector('#bd-read')  .addEventListener('click', () => {
    DB.addRecent(book, author.author);
    const p = DB.getProgress(book.path);
    openReader(book.path, book.title, p ? p.page : 1);
  });
  div.querySelector('#bd-dl').addEventListener('click', () => downloadBook(book.path, book.title+'.pdf'));
  const ocrBtn = div.querySelector('#bd-ocr');
  if (ocrBtn) ocrBtn.addEventListener('click', () => runOcr(book, author.author));
  const favBtn = div.querySelector('#bd-fav');
  favBtn.addEventListener('click', async () => {
    const added = await DB.toggleFav(book, author.author);
    favBtn.textContent = added ? '♥ পছন্দ' : '♡ পছন্দ';
    favBtn.classList.toggle('fav-active', added);
    toast(added ? 'পছন্দতালিকায় যোগ হয়েছে ♥' : 'সরানো হয়েছে', added ? 'success' : 'info');
  });
  div.querySelector('#bd-trash').addEventListener('click', async () => {
    if (!confirm(`"${book.title}" ট্র্যাশে পাঠাবেন?`)) return;
    await trashFile(book.path);
    goBack();
  });
}

/* ── RANDOM ── */
function renderRandom() {
  if (!_library.length) return;
  let author = rand(_library), book = rand(author.books);
  const page = document.createElement('div');
  page.className = 'random-page';
  function reroll() { author = rand(_library); book = rand(author.books); render(); }
  function render() {
    const isFav = DB.isFav(book.path);
    page.innerHTML = `
      <div class="random-label">এলোমেলো বই · Random Pick</div>
      <div class="random-card">
        <div class="random-cover"></div>
        <div class="random-title">${esc(book.title)}</div>
        <div class="random-author">✍ ${esc(author.author)}</div>
        <div class="random-actions">
          <button class="btn btn-primary"   id="rr">📖 পড়ুন</button>
          <button class="btn btn-secondary" id="rd">⬇ ডাউনলোড</button>
          <button class="btn btn-ghost"     id="ro">🔍 OCR</button>
          <button class="btn btn-ghost ${isFav?'fav-active':''}" id="rf">${isFav?'♥':'♡'}</button>
        </div>
        <button class="random-reroll" id="rrr">🎲 আরেকটি বই দেখুন</button>
      </div>`;
    page.querySelector('#rr') .addEventListener('click', () => { DB.addRecent(book,author.author); openReader(book.path,book.title); });
    page.querySelector('#rd') .addEventListener('click', () => downloadBook(book.path,book.title+'.pdf'));
    page.querySelector('#ro') .addEventListener('click', () => runOcr(book,author.author));
    page.querySelector('#rrr').addEventListener('click', reroll);
    const fb = page.querySelector('#rf');
    fb.addEventListener('click', async () => {
      const added = await DB.toggleFav(book, author.author);
      fb.textContent = added?'♥':'♡'; fb.classList.toggle('fav-active',added);
      toast(added?'পছন্দতালিকায় যোগ হয়েছে ♥':'সরানো হয়েছে', added?'success':'info');
    });
  }
  render(); content.innerHTML = ''; content.appendChild(page);
}

/* ── RECENTS ── */

/* ── RECENTS ── */
function renderRecents() {
  const recents = DB.getRecents();
  const div = document.createElement('div');
  div.innerHTML = `
    <div class="section-header">
      <h2 class="section-title">Recently Read</h2>
      <span class="section-count">${recents.length} books</span>
      ${recents.length ? `<button class="btn btn-ghost btn-sm section-action" id="clr">Clear all</button>` : ''}
    </div>
    <div id="rl"></div>`;
  content.innerHTML = ''; content.appendChild(div);
  div.querySelector('#clr')?.addEventListener('click', async () => {
    await DB.clearRecents(); navigate(renderRecents,'Recents'); toast('Cleared.','info');
  });
  const body = div.querySelector('#rl');
  if (!recents.length) {
    body.innerHTML = `<div class="empty-state"><span class="empty-icon">🕐</span>
      <div class="empty-text">No recent books yet.</div>
      <div class="empty-sub">Open a book to start reading.</div></div>`;
    return;
  }
  const grid = document.createElement('div'); grid.className = 'books-grid';
  recents.forEach(r => {
    const found = findByPath(r.path); if (!found) return;
    const card = buildBookCard(found.book, found.author);
    const stamp = document.createElement('div');
    stamp.style.cssText = 'font-size:10px;color:var(--ink-faint);font-family:var(--mono);margin-top:6px';
    stamp.textContent = fmtDate(r.ts); card.appendChild(stamp); grid.appendChild(card);
  });
  body.appendChild(grid);
}

/* ── FAVOURITES ── */
function renderFavs() {
  const favs = Object.values(DB.getFavs());
  const div = document.createElement('div');
  div.innerHTML = `
    <div class="section-header">
      <h2 class="section-title">Favourites</h2>
      <span class="section-count">${favs.length} books</span>
    </div><div id="fl"></div>`;
  content.innerHTML = ''; content.appendChild(div);
  const body = div.querySelector('#fl');
  if (!favs.length) {
    body.innerHTML = `<div class="empty-state"><span class="empty-icon">♡</span>
      <div class="empty-text">No favourites yet.</div>
      <div class="empty-sub">Click ♡ on any book to add it here.</div></div>`;
    return;
  }
  const grid = document.createElement('div'); grid.className = 'books-grid';
  favs.forEach(r => { const f = findByPath(r.path); if (f) grid.appendChild(buildBookCard(f.book, f.author)); });
  body.appendChild(grid);
}

/* ── DUPLICATES (Quick Scan / BLAKE3 only, with cancel) ── */
async function renderDuplicates() {
  const div = document.createElement('div');
  content.innerHTML = ''; content.appendChild(div);

  // Load cached result
  let cached = null;
  try {
    const r = await apiFetch('/api/userdata/dupe_cache');
    if (r.data && r.data.ran_at) cached = r.data;
  } catch {}

  function fmtDur(ms) {
    if (ms < 1000) return ms + 'ms';
    if (ms < 60000) return (ms/1000).toFixed(1) + 's';
    return Math.round(ms/60000) + 'm ' + Math.round((ms%60000)/1000) + 's';
  }
  function fmtTs(ts) {
    try { return new Date(ts).toLocaleString(); } catch { return ''; }
  }

  function renderResults(data, fromCache) {
    const { exact_groups=[], total_duplicate_books=0, ran_at, duration_ms, book_count } = data;
    div.innerHTML = `
      <div class="section-header">
        <h2 class="section-title">Duplicate Detection</h2>
        ${fromCache ? `<span class="dupe-cache-badge">Cached result</span>` : ''}
      </div>
      <div class="dupe-info-card">
        <div class="dupe-tier">
          <span class="dupe-tier-badge exact">BLAKE3 Hash</span>
          <span>Finds byte-for-byte identical files — exact copies, renamed duplicates.</span>
        </div>
        <p class="dupe-note">Fast — only reads file headers for hashing. Results are cached and shown until you rescan.</p>
      </div>
      ${ran_at ? `<div class="dupe-history-bar">
        <span>Last scan: <strong>${fmtTs(ran_at)}</strong></span>
        <span>Duration: <strong>${fmtDur(duration_ms||0)}</strong></span>
        <span>Library size: <strong>${book_count||'?'} books</strong></span>
      </div>` : ''}
      <div style="display:flex;gap:10px;margin-bottom:18px;flex-wrap:wrap;align-items:center;">
        <button class="btn btn-primary" id="scan-btn">🔍 Scan for Duplicates</button>
        ${fromCache ? `<button class="btn btn-secondary" id="cached-btn">📋 Show Cached</button>` : ''}
        <span id="scan-status" style="font-family:var(--mono);font-size:11px;color:var(--ink-muted)"></span>
      </div>
      <div id="dup-results"></div>`;

    div.querySelector('#scan-btn').addEventListener('click', () => runScan());
    div.querySelector('#cached-btn')?.addEventListener('click', () => renderResults(cached, true));

    const el = div.querySelector('#dup-results');
    if (!exact_groups.length || total_duplicate_books === 0) {
      el.innerHTML = `<div class="empty-state">
        <span class="empty-icon">✓</span>
        <div class="empty-text">No duplicates found.</div>
        <div class="empty-sub">Your library looks clean!</div></div>`;
      return;
    }

    const allDupeBooks = [];
    exact_groups.forEach(g => (g.books||[]).slice(1).forEach(b => allDupeBooks.push(b)));

    el.innerHTML = `<div class="dupe-action-bar">
      <div class="dupe-summary">
        Found <strong>${total_duplicate_books}</strong> duplicate files in
        <strong>${exact_groups.length}</strong> groups.
      </div>
      <button class="btn btn-ghost btn-sm" id="trash-all"
        style="color:#e05555;border-color:#e05555;">
        🗑 Trash all duplicates (${allDupeBooks.length})
      </button>
    </div>`;

    el.querySelector('#trash-all').addEventListener('click', async () => {
      if (!confirm(`Move ${allDupeBooks.length} duplicate files to trash?\n\nThe first file in each group will be kept.`)) return;
      const btn = el.querySelector('#trash-all');
      btn.disabled = true; btn.textContent = 'Moving…';
      let done = 0;
      for (const b of allDupeBooks) {
        try { await apiFetch('/api/trash/move', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ path: b.path }) }); done++; }
        catch {}
      }
      await loadLibrary(true); rebuildIndex();
      toast(`${done} files moved to trash.`, 'success', 5000);
      await apiFetch('/api/userdata/dupe_cache', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ data: {} }) }).catch(()=>{});
      navigate(renderDuplicates, 'Duplicates');
    });

    exact_groups.forEach(group => {
      const card = document.createElement('div'); card.className = 'dupe-group';
      card.innerHTML = `<div class="dupe-group-label">
        <span class="dupe-tier-badge exact">Exact copy</span>
        <span style="font-family:var(--mono);font-size:9px;color:var(--ink-faint)">${group.hash||''}</span>
        <span style="margin-left:auto;font-family:var(--mono);font-size:10px;color:var(--ink-faint)">${(group.books||[]).length} files</span>
      </div>` +
      (group.books||[]).map((b, i) => `
        <div class="dupe-item ${i===0?'dupe-keep':''}">
          <div style="flex:1;min-width:0">
            ${i===0 ? '<span class="dupe-keep-badge">Keep</span>' : '<span class="dupe-del-badge">Duplicate</span>'}
            <div class="dupe-name">${esc(b.title)}</div>
            <div class="dupe-meta">${esc(b.author)}${b.size_kb?' · '+b.size_kb+' KB':''}</div>
            <div class="dupe-path">${esc(b.path)}</div>
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0">
            <button class="btn btn-secondary btn-sm" data-op="${esc(b.path)}" data-ot="${esc(b.title)}">📖 Open</button>
            ${i>0?`<button class="btn btn-ghost btn-sm" data-tp="${esc(b.path)}" data-tt="${esc(b.title)}" style="color:#e05555;border-color:#e05555">🗑 Trash</button>`:''}
          </div>
        </div>`).join('');
      el.appendChild(card);
      card.querySelectorAll('[data-op]').forEach(btn => btn.addEventListener('click', () => openReader(btn.dataset.op, btn.dataset.ot)));
      card.querySelectorAll('[data-tp]').forEach(btn => btn.addEventListener('click', async () => {
        if (!confirm(`Move "${btn.dataset.tt}" to trash?`)) return;
        await trashFile(btn.dataset.tp);
        btn.closest('.dupe-item').style.opacity = '0.35';
        btn.disabled = true; btn.textContent = 'Trashed';
      }));
    });
  }

  // ── Scan with cancel support ──────────────────────────────────────
  let scanController = null;

  async function runScan() {
    // If already scanning, cancel it
    if (scanController) {
      scanController.abort();
      scanController = null;
      return;
    }
    scanController = new AbortController();
    const scanBtn = div.querySelector('#scan-btn');
    const status  = div.querySelector('#scan-status');
    const el      = div.querySelector('#dup-results');
    if (scanBtn) { scanBtn.textContent = '✕ Cancel'; scanBtn.classList.remove('btn-primary'); scanBtn.classList.add('btn-ghost'); }
    if (el) el.innerHTML = `<div class="spinner-wrap"><div class="spinner"></div><span class="spinner-label">Computing BLAKE3 hashes…</span></div>`;

    const t0 = Date.now();
    try {
      const data = await apiFetch('/api/duplicates?skip_content=true', { signal: scanController.signal });
      const duration_ms = Date.now() - t0;
      data.ran_at = Date.now(); data.duration_ms = duration_ms;
      data.scan_type = 'quick'; data.book_count = getStats().books;
      try { await apiFetch('/api/userdata/dupe_cache', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ data }) }); cached = data; } catch {}
      scanController = null;
      renderResults(data, false);
    } catch (e) {
      scanController = null;
      if (e.name === 'AbortError') {
        if (scanBtn) { scanBtn.textContent = '🔍 Scan for Duplicates'; scanBtn.classList.add('btn-primary'); scanBtn.classList.remove('btn-ghost'); }
        if (el) el.innerHTML = `<div class="empty-state"><span class="empty-icon">✕</span><div class="empty-text">Scan cancelled.</div></div>`;
        toast('Scan cancelled.', 'info');
      } else {
        if (el) el.innerHTML = `<div class="empty-state"><span class="empty-icon">⚠</span><div class="empty-text">Error: ${esc(e.message)}</div></div>`;
      }
    }
  }

  // Initial render
  if (cached && cached.ran_at) renderResults(cached, true);
  else {
    div.innerHTML = `
      <div class="section-header"><h2 class="section-title">Duplicate Detection</h2></div>
      <div class="dupe-info-card">
        <div class="dupe-tier">
          <span class="dupe-tier-badge exact">BLAKE3 Hash</span>
          <span>Finds byte-for-byte identical files — exact copies, renamed duplicates. Fast and accurate.</span>
        </div>
        <p class="dupe-note">Results are cached after scanning so you can review them anytime.</p>
      </div>
      <div style="display:flex;gap:10px;margin-bottom:18px;">
        <button class="btn btn-primary" id="scan-btn">🔍 Scan for Duplicates</button>
      </div>
      <div id="dup-results"></div>`;
    div.querySelector('#scan-btn').addEventListener('click', () => runScan());
  }
}

/* ── TRASH ── */
async function renderTrash() {
  showLoading('Loading trash…');
  let data;
  try { data = await apiFetch('/api/trash'); }
  catch (e) { content.innerHTML = `<div class="empty-state"><span class="empty-icon">🗑</span><div class="empty-text">Error: ${esc(e.message)}</div></div>`; return; }
  const { items } = data;
  const div = document.createElement('div');
  div.innerHTML = `
    <div class="section-header">
      <h2 class="section-title">Trash</h2>
      <span class="section-count">${items.length} files</span>
      ${items.length ? `<button class="btn btn-ghost btn-sm section-action" id="empty-trash" style="color:#e05555;border-color:#e05555">Delete all permanently</button>` : ''}
    </div>
    ${!items.length ? `<div class="empty-state"><span class="empty-icon">🗑</span><div class="empty-text">Trash is empty.</div><div class="empty-sub">Deleted books appear here before permanent removal.</div></div>` :
      `<p style="font-family:var(--mono);font-size:11px;color:var(--ink-muted);margin-bottom:18px">
        ♻ Restore moves the file back to the library · 🗑 Delete removes it permanently</p>`}
    <div id="trash-list"></div>`;
  content.innerHTML = ''; content.appendChild(div);
  div.querySelector('#empty-trash')?.addEventListener('click', async () => {
    if (!confirm('Permanently delete everything in trash? This cannot be undone.')) return;
    try { await apiFetch('/api/trash/empty', { method:'DELETE' }); toast('Trash emptied.','success'); navigate(renderTrash,'Trash'); }
    catch (e) { toast('Error: '+e.message,'error'); }
  });
  const list = div.querySelector('#trash-list');
  items.forEach(item => {
    const row = document.createElement('div'); row.className = 'trash-row';
    row.innerHTML = `
      <div class="trash-info">
        <div class="trash-name">${esc(item.name)}</div>
        <div class="trash-meta">${item.size_kb} KB · Deleted ${esc(item.trashed)}</div>
      </div>
      <div class="trash-actions">
        <button class="btn btn-secondary btn-sm trash-restore" data-path="${esc(item.path)}" data-name="${esc(item.name)}">♻ Restore</button>
        <button class="btn btn-ghost btn-sm trash-del" data-path="${esc(item.path)}" style="color:#e05555;border-color:#e05555">🗑 Delete</button>
      </div>`;
    row.querySelector('.trash-restore').addEventListener('click', async function() {
      try {
        const res = await apiFetch('/api/trash/restore', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ path: this.dataset.path }) });
        await loadLibrary(true); rebuildIndex();
        toast(`"${this.dataset.name}" restored → ${res.restored_to}`, 'success', 5000);
        navigate(renderTrash,'Trash');
      } catch (e) { toast('Restore failed: '+e.message,'error'); }
    });
    row.querySelector('.trash-del').addEventListener('click', async function() {
      if (!confirm(`Permanently delete "${item.name}"?`)) return;
      try { await apiFetch('/api/trash/delete?path='+encodeURIComponent(this.dataset.path), { method:'DELETE' }); toast('Deleted permanently.','success'); navigate(renderTrash,'Trash'); }
      catch (e) { toast('Error: '+e.message,'error'); }
    });
    list.appendChild(row);
  });
}

/* ── SETTINGS ── */
function renderSettings() {
  const s = DB.getSettings(); const stat = getStats();
  const div = document.createElement('div');
  div.innerHTML = `
    <div class="section-header"><h2 class="section-title">Settings</h2></div>
    <div class="settings-grid">

      <div class="settings-card">
        <div class="settings-card-title">📚 Library</div>
        <div class="settings-row">
          <div class="settings-label">Refresh library<div class="settings-sub">Re-scan bengali-literature/</div></div>
          <button class="btn btn-secondary btn-sm" id="s-refresh">🔄 Refresh</button>
        </div>
        <div class="settings-row"><div class="settings-label">Total authors</div><div class="settings-value">${stat.authors}</div></div>
        <div class="settings-row"><div class="settings-label">Total books</div><div class="settings-value">${stat.books}</div></div>
        <div class="settings-row">
          <div class="settings-label">Empty author folders<div class="settings-sub">Folders with no PDFs</div></div>
          <button class="btn btn-secondary btn-sm" id="s-empty-dirs">📂 Find</button>
        </div>
        <div class="settings-row">
          <div class="settings-label">Duplicates</div>
          <button class="btn btn-secondary btn-sm" id="s-dupes">⚠ Check</button>
        </div>
        <div class="settings-row">
          <div class="settings-label">Trash</div>
          <button class="btn btn-secondary btn-sm" id="s-trash">🗑 View</button>
        </div>
      </div>

      <div class="settings-card">
        <div class="settings-card-title">🎨 Theme</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:4px 0">
          ${[['parchment','📜 Parchment'],['dark','🌑 Dark'],['ocean','🌊 Ocean'],['forest','🌲 Forest'],['slate','🪨 Slate'],['rose','🌹 Rose']].map(([t,l]) =>
            `<button class="btn btn-secondary btn-sm theme-settings-btn ${document.documentElement.dataset.theme===t?'fav-active':''}" data-t="${t}">${l}</button>`
          ).join('')}
        </div>
      </div>

      <div class="settings-card">
        <div class="settings-card-title">💾 User Data</div>
        <div class="settings-row">
          <div class="settings-label">Storage<div class="settings-sub">Saved in what-you-doing/ as JSON</div></div>
          <span class="settings-value" style="color:var(--accent)">Server ✓</span>
        </div>
        <div class="settings-row">
          <div class="settings-label">Clear recents<div class="settings-sub">${DB.getRecents().length} entries</div></div>
          <button class="btn btn-ghost btn-sm" id="s-clr-rec">Clear</button>
        </div>
        <div class="settings-row">
          <div class="settings-label">Clear reading progress</div>
          <button class="btn btn-ghost btn-sm" id="s-clr-prog">Clear</button>
        </div>
        <div class="settings-row">
          <div class="settings-label">Clear favourites<div class="settings-sub">${Object.keys(DB.getFavs()).length} books</div></div>
          <button class="btn btn-ghost btn-sm" id="s-clr-fav">Clear</button>
        </div>
      </div>

      <div class="settings-card">
        <div class="settings-card-title">ℹ About</div>
        <div class="settings-row"><div class="settings-label">Version</div><div class="settings-value">2.0.0</div></div>
        <div class="settings-row"><div class="settings-label">Backend</div><div class="settings-value">FastAPI + Python</div></div>
        <div class="settings-row"><div class="settings-label">OCR</div><div class="settings-value">OCRmyPDF · Tesseract</div></div>
        <div class="settings-row"><div class="settings-label">Hashing</div><div class="settings-value">BLAKE3</div></div>
      </div>

    </div>

    <div id="empty-dirs-panel" class="hidden" style="margin-top:28px">
      <div class="section-header" style="margin-bottom:16px">
        <h3 class="section-title" style="font-size:1.1rem">Empty Author Folders</h3>
        <span class="section-count" id="empty-dirs-count"></span>
        <button class="btn btn-ghost btn-sm section-action" id="del-all-empty" style="color:#e05555;border-color:#e05555;display:none">🗑 Delete all</button>
      </div>
      <div id="empty-dirs-list"></div>
    </div>`;

  content.innerHTML = ''; content.appendChild(div);

  // Theme buttons
  div.querySelectorAll('.theme-settings-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      applyTheme(btn.dataset.t);
      div.querySelectorAll('.theme-settings-btn').forEach(b => b.classList.toggle('fav-active', b.dataset.t === btn.dataset.t));
    });
  });

  div.querySelector('#s-refresh').addEventListener('click', async () => {
    toast('Scanning library…','info');
    try { await loadLibrary(true); rebuildIndex(); toast(`${getStats().authors} authors, ${getStats().books} books.`,'success'); navigate(renderSettings,'Settings'); }
    catch (e) { toast('Error: '+e,'error'); }
  });
  div.querySelector('#s-dupes').addEventListener('click', () => navigate(renderDuplicates,'Duplicates'));
  div.querySelector('#s-trash').addEventListener('click', () => navigate(renderTrash,'Trash'));
  div.querySelector('#s-clr-rec') .addEventListener('click', async () => { await DB.clearRecents();  toast('Recents cleared.','info'); navigate(renderSettings,'Settings'); });
  div.querySelector('#s-clr-prog').addEventListener('click', async () => { await DB.clearProgress(); toast('Progress cleared.','info'); });
  div.querySelector('#s-clr-fav') .addEventListener('click', async () => {
    if (!confirm('Clear all favourites?')) return;
    await DB._set('favs',{}); toast('Favourites cleared.','info'); navigate(renderSettings,'Settings');
  });

  // Empty dirs
  div.querySelector('#s-empty-dirs').addEventListener('click', async () => {
    const panel = div.querySelector('#empty-dirs-panel');
    const listEl = div.querySelector('#empty-dirs-list');
    const countEl = div.querySelector('#empty-dirs-count');
    const delAllBtn = div.querySelector('#del-all-empty');
    panel.classList.remove('hidden');
    listEl.innerHTML = `<div class="spinner-wrap" style="padding:30px 0"><div class="spinner"></div><span class="spinner-label">Scanning…</span></div>`;
    let data;
    try { data = await apiFetch('/api/library/empty-dirs'); }
    catch (e) { listEl.innerHTML = `<div class="empty-state"><div class="empty-text">Error: ${esc(e.message)}</div></div>`; return; }
    const { empty_dirs, count } = data;
    countEl.textContent = `${count} found`;
    if (!count) { listEl.innerHTML = `<div class="empty-state" style="padding:30px 0"><span class="empty-icon" style="font-size:32px">✓</span><div class="empty-text">No empty folders found.</div></div>`; return; }
    delAllBtn.style.display = '';
    listEl.innerHTML = empty_dirs.map(d => `
      <div class="empty-dir-row" data-path="${esc(d.path)}">
        <div><div class="empty-dir-name">${esc(d.name)}</div>
          <div class="empty-dir-meta">${d.file_count>0 ? d.file_count+' non-PDF file(s): '+d.files.map(f=>esc(f)).join(', ') : 'Completely empty'}</div>
        </div>
        <button class="btn btn-ghost btn-sm" data-path="${esc(d.path)}" data-name="${esc(d.name)}" style="color:#e05555;border-color:#e05555;flex-shrink:0">🗑 Delete</button>
      </div>`).join('');
    listEl.querySelectorAll('[data-name]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm(`Delete empty folder "${btn.dataset.name}"?`)) return;
        await apiFetch('/api/library/empty-dirs', { method:'DELETE', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ paths:[btn.dataset.path] }) });
        btn.closest('.empty-dir-row').remove();
        const rem = listEl.querySelectorAll('.empty-dir-row').length;
        countEl.textContent = rem + ' found';
        if (!rem) { listEl.innerHTML = '<div style="padding:16px 0;color:var(--ink-muted);font-family:var(--mono);font-size:12px">✓ All removed.</div>'; delAllBtn.style.display='none'; }
      });
    });
    delAllBtn.addEventListener('click', async () => {
      if (!confirm(`Delete all ${count} empty folders?`)) return;
      const res = await apiFetch('/api/library/empty-dirs', { method:'DELETE', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ paths: empty_dirs.map(d=>d.path) }) });
      toast(`${res.removed_count} folder(s) removed.`, 'success');
      panel.classList.add('hidden');
      await loadLibrary(true); rebuildIndex();
    });
  });
}

/* ── TRASH HELPER ── */
async function trashFile(path) {
  try {
    await apiFetch('/api/trash/move', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ path }) });
    await loadLibrary(true); rebuildIndex();
    toast('Moved to trash.', 'success');
  } catch (e) { toast('Error: '+e.message, 'error'); }
}

/* ── THEME SYSTEM ── */
function applyTheme(name) {
  document.documentElement.dataset.theme = name;
  localStorage.setItem('bl_theme', name);
}

function initTheme() {
  const saved = localStorage.getItem('bl_theme') || 'parchment';
  applyTheme(saved);

  // Dropdown toggle
  const btn = document.getElementById('theme-btn');
  const dd  = document.getElementById('theme-dropdown');
  if (!btn || !dd) return;

  btn.addEventListener('click', e => { e.stopPropagation(); dd.classList.toggle('hidden'); });
  document.addEventListener('click', () => dd.classList.add('hidden'));

  dd.querySelectorAll('.theme-opt').forEach(opt => {
    if (opt.dataset.theme === saved) opt.classList.add('active');
    opt.addEventListener('click', () => {
      applyTheme(opt.dataset.theme);
      dd.querySelectorAll('.theme-opt').forEach(o => o.classList.toggle('active', o.dataset.theme === opt.dataset.theme));
      dd.classList.add('hidden');
      toast(`Theme: ${opt.textContent.trim()}`, 'info', 1500);
    });
  });
}

/* ══════════════════════════════════════════════
   KEYBOARD SHORTCUTS
   ══════════════════════════════════════════════ */
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if (e.altKey && e.key === 'ArrowLeft')  { e.preventDefault(); goBack(); }
  if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); goForward(); }
  if ((e.ctrlKey||e.metaKey) && e.key==='f') {
    e.preventDefault(); searchInput.focus(); searchInput.select();
  }
  if (e.key === 'Escape') { searchInput.value = ''; if (_lastQuery) { _lastQuery=''; if(navHistory[navIdx]?.label==='Search') goBack(); } }
});

/* ══════════════════════════════════════════════
   BOOT
   ══════════════════════════════════════════════ */
(async () => {
  initTheme();
  await DB.loadAll();
  navigate(renderHome, 'Home');
})();
