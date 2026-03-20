# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Project overview

Sklepik Szkolny — a POS (point of sale) system for a school. Intended to run on Samsung Galaxy Tab S10 FE tablets. The UI and all user-facing text are **in Polish**.

The project exists in two versions:
- `sklepik_pro.html` — original static offline version (localStorage, no server)
- **backend version** (active) — Flask + SQLAlchemy, shared database for multiple tablets, **with offline mode for sales**

The backend version runs as a **PWA (Progressive Web App)** — installable from Chrome on Android, works fully offline after the first visit (service worker caches the entire UI shell).

## How to run

```bash
# Locally via Docker (recommended)
cp .env.example .env        # set SECRET_KEY
docker compose up --build   # http://localhost:5000

# Locally without Docker
pip install -r requirements.txt
flask run
```

First login: **admin / admin** — change the password after startup.

Detailed deployment instructions for PythonAnywhere and Render: `DEPLOY.md`.

## Architecture

### Backend — `app.py` (single file)

Flask + SQLAlchemy + Flask-Login. Intentionally everything in one file for readability.

**Database models:**
- `User` — id, username, password_hash, is_admin, must_change_password
- `Product` — id, name, emoji, price (grosz), stock, barcode, category, img (base64)
- `Sale` — id, ts (ms timestamp), date (YYYY-MM-DD), total, paid, user_id
- `SaleItem` — id, sale_id, product_id, name, emoji, qty, price (snapshot at time of sale)
- `AuditLog` — id, ts (ms), user_id, username (snapshot), action, detail — critical admin and login events

**Database:**
- Defaults to SQLite at `./data/sklepik.db`
- Can be overridden via the `DATABASE_URL` environment variable (PostgreSQL/MySQL)
- `init_db()` creates tables and the `admin/admin` account on first run (with `must_change_password=True`)
- Online migration: `init_db()` adds the `must_change_password` column to existing databases (ALTER TABLE with error handling if already present)

### Frontend — `templates/index.html` + `static/app.js`

SPA (vanilla JS). HTML/CSS in `templates/index.html`, all JavaScript in `static/app.js`. Based on `sklepik_pro.html` with the following changes:
- `localStorage` replaced by `fetch()` calls to the REST API
- Cart and numpad remain **client-side** (no sync needed)
- Barcode scanning — client-side (camera, BarcodeDetector + ZXing)
- New **Accounts** tab (visible to admins only)
- Stock/Backup/Accounts tabs hidden for cashiers
- **Offline mode** — sales work without internet, auto-sync on reconnect
- **PWA** — registers service worker on startup; toast shown when an update is available

### Login page — `templates/login.html`

Minimalist, matches the style of the main app. Uses `fetch()` to `POST /login`.

### Static assets — `static/`

All external dependencies are **self-hosted** (no CDN) — a hard requirement for offline support:

```
static/
├── app.js                 # All SPA JavaScript (extracted from index.html)
├── manifest.json          # PWA manifest
├── sw.js                  # Service worker (served via /sw.js in app.py)
├── fonts/
│   ├── Fredoka-latin.woff2       # heading font, latin subset
│   ├── Fredoka-latin-ext.woff2   # heading font, latin-ext subset (ą, ę, ś, ł...)
│   ├── Nunito-latin.woff2        # latin subset (includes ó)
│   └── Nunito-latin-ext.woff2    # latin-ext subset (ą, ę, ś, ł, ź, ż, ć, ń)
├── zxing/
│   └── zxing.min.js       # @zxing/library 0.19.1 UMD (jsDelivr)
└── icons/
    ├── icon-192.png
    └── icon-512.png
```

`generate_icons.py` — one-time script (requires Pillow) to regenerate PWA icons.

## PWA and tablet installation

The app meets PWA criteria — Chrome on Android offers "Add to home screen" after login. Once installed, it runs without the browser bar (`display: standalone`).

**Installation on Samsung Galaxy Tab S10 FE:**
1. Open Chrome → navigate to the app URL → log in
2. Chrome will show an "Add to home screen" banner (or use the ⋮ menu → Add)
3. Done — the app works fully offline from that point

**Service worker (`static/sw.js`):**
- Cache-First strategy for the UI shell: `/app`, `/login`, `static/app.js`, fonts, ZXing
- Network-Only for `/api/*` — IndexedDB handles offline data (see below)
- `CACHE_NAME = 'sklepik-v19'` — increment on every deployment to force an update
- `Service-Worker-Allowed: /` header on the `/sw.js` route — enables scope across the entire app even though the file is served from `/static/`

**Updating after deployment:** change `CACHE_NAME` in `static/sw.js` (`v1` → `v2` etc.). Chrome detects the change on the next open, installs the new version in the background, and shows a toast to the user.

---

## Offline mode

The app handles connectivity interruptions at two levels:

**Level 1 — Service Worker (UI shell):** HTML, JS, CSS, fonts, ZXing cached locally — the app loads without network even on a cold tablet start.

**Level 2 — IndexedDB (data):** products, sales queue, user session.

**What works offline:** Sales tab only

**What requires internet:** login (first time), Stock, Reports, Accounts/Backup

**IndexedDB mechanism:**
- `offlineDB` (IndexedDB `sklepik-offline`, v1) — 3 stores:
  - `products` — product cache from API (including base64 images); updated on every `loadProducts()`
  - `pending_sales` — sales queue for synchronisation (autoIncrement `localId`)
  - `user` — cached logged-in user (allows tablet restart while offline)
- `probeConnectivity()` — fetches `/api/ping` with a 3s timeout; any HTTP response = online
- `setOnlineState(bool)` — sole place where state changes; updates header badge, banner on Sales page, Confirm button style
- When offline: sale goes to `pending_sales` in IndexedDB, product stock decremented locally
- Auto-sync: polls every 15s when offline + `window.online` event → `syncPendingSales()`
- `syncPendingSales()` — iterates the queue, POSTs to `/api/sales`, aborts on connection loss (rest stays in queue), collects server errors in a `failed` array and shows a combined alert with details at the end

**Important for offline:**
- Product stock in IndexedDB is decremented locally after each offline sale — subsequent sales in the same offline session see the updated stock
- On reconnect, `loadProducts()` fetches actual stock values from the server
- Tablet/browser restart while offline: products and sales queue survive the restart (IndexedDB is persistent); cached user allows the app to start without logging in

## API Endpoints

All endpoints (except `/api/ping`) require an active session (401 → redirect to login). Endpoints marked `[admin]` require `is_admin=True` (403 if not).

| Method | Path | Description |
|---|---|---|
| GET | `/api/ping` | Connectivity check — **no auth required** |
| GET | `/sw.js` | PWA service worker — `no-cache`, `Service-Worker-Allowed: /` |
| GET | `/manifest.json` | PWA manifest |
| GET | `/api/me` | Info about the logged-in user |
| GET | `/api/products` | List all products |
| POST | `/api/products` | Add a product `[admin]` |
| PUT | `/api/products/<id>` | Edit a product `[admin]` |
| DELETE | `/api/products/<id>` | Delete a product `[admin]` |
| POST | `/api/products/<id>/restock` | Restock `[admin]` |
| GET | `/api/sales?date=YYYY-MM-DD` | Transactions (optional date filter) |
| POST | `/api/sales` | Commit a sale (atomically checks stock) |
| GET | `/api/export` | Download full JSON backup `[admin]` |
| GET | `/api/export/products` | Download products-only JSON `[admin]` |
| POST | `/api/import` | Upload JSON backup (overwrites data) `[admin]` |
| GET | `/api/users` | List users `[admin]` |
| POST | `/api/users` | Add a user `[admin]` |
| DELETE | `/api/users/<id>` | Delete a user `[admin]` |
| PUT | `/api/users/<id>/password` | Change password (admin or own account) |
| GET | `/api/audit` | Last 200 audit log entries `[admin]` |

## Key implementation rules

**Prices:** always integers in grosz (1 PLN = 100). Use `fPLN(grosz)` for display.

**Timestamps:** the server assigns the sale time (`datetime.now(timezone.utc)`), not the client. Important when multiple tablets are in use. Offline sales have `ts_local` (local time) in IndexedDB, but the server assigns its own `ts` on sync.

**Images:** resize to max 300px JPEG 85% happens **client-side** (`handleImg()` in `static/app.js`) before sending to the API. Result is ~20-40 KB base64 per product. The server stores base64 in the `img TEXT` column. Images are also in the IndexedDB cache — the UI works offline with images.

**Atomic sale:** `POST /api/sales` uses `with_for_update()` on product rows — two tablets cannot simultaneously sell the same item beyond its stock level.

**Network error handling in `api()`:** the wrapper uses `AbortController` with an 8s timeout. On `TypeError` or `AbortError` it throws an error with `err.isOffline = true`. Callers can check this flag and apply an offline fallback instead of showing an error.

**User roles:**
- `is_admin=True` → access to all tabs and endpoints
- `is_admin=False` (cashier) → Sales and Report only; Stock/Backup/Accounts tabs hidden

**Backup format:** compatible with the original static version (`sklepik_pro.html`). You can import data from localStorage by exporting from the original app. Sales import requires an explicit `_import_sales=true` flag — by default the transaction history is preserved.

**Audit log:** critical actions (login, add/edit/delete product, add/delete user, password change, import) are written to the `AuditLog` model. Accessible via `GET /api/audit` (admin).

**Forced password change:** the `admin/admin` account and new accounts created by an admin have `must_change_password=True`. The frontend (`init()`) detects this flag and opens `openPasswordModal(forced=true)` — the modal cannot be closed without changing the password.

## JS functions in static/app.js

### Main application functions
- `init()` — checks connectivity and session (`GET /api/me` with IDB fallback), loads products, initialises UI, starts startup sync; detects `must_change_password`
- `api(method, path, body)` — fetch wrapper; AbortController 8s; `err.isOffline=true` on network failure; auto-recovery `setOnlineState(true)` on successful response
- `loadProducts()` — online: fetch from API + save to IDB; offline: read from IDB
- `finalize()` — online: POST `/api/sales`; offline: `saveOfflineSale()`
- `saveOfflineSale(cart, paid, total)` — save to IDB queue + local stock decrement
- `syncPendingSales()` — iterates `pending_sales` in IDB, POST to `/api/sales`, alert on server errors
- `saveProduct()` — POST or PUT to API depending on `editingId`
- `restock(id)` — POST to `/api/products/<id>/restock`
- `delProduct(id)` — DELETE to API
- `renderReport()` — fetches `GET /api/sales?date=...` and renders the table; toast when offline
- `doPrint()` — renders report and calls `window.print()`
- `doImport()` — sends JSON to `POST /api/import` with optional `_import_sales` flag
- `previewImport(input)` — parses JSON file and shows preview (product/transaction count) before import
- `handleImg(input)` — client-side image resize to max 300px before sending
- `decodeBarcode(file)` — BarcodeDetector API or ZXing fallback

### Navigation and rendering
- `goPage(name, btn)` — switches tabs; calls the appropriate render (renderStock, renderReport, renderUsers, renderProducts)
- `renderProducts()` — filters by category and search, sorts cart items to top
- `renderStock()` — stock view with quantities and action buttons
- `renderCategories()` / `getCategories()` / `setCategory(cat)` — dynamic category filters
- `renderUsers()` / `openUserModal()` / `closeUserModal()` / `saveUser()` / `deleteUser()` — account management
- `renderCart()` — cart with qty buttons; also re-renders products after every change
- `renderQuickAmounts()` — generates quick payment buttons (1 PLN – 200 PLN)

### Cart and numpad
- `addToCart(id)` / `changeQty(id, d)` / `cartTotal()` / `clearCart()`
- `npDigit(d)` / `npDelete()` / `npClear()` / `npSet(g)` / `npExact()` / `updateNumDisplay()`

### Product and password modals
- `openAddModal()` / `openEditModal(id)` / `closeModal()` / `removeImg()`
- `openPasswordModal(forced)` / `closePasswordModal()` / `changeMyPassword()`

### Scanner
- `initHwScanner()` — `keydown` listener for HW scanner (buffer with 60ms timeout, min 4 chars + Enter); also routes slow (manual) digit keystrokes to the numpad on the Sales page
- `openScanner(mode)` — opens file input for camera scanning
- `processScanImage(input)` / `decodeBarcode(file)` / `handleScannedCode(code)` / `closeScanner()`
- `loadImage(file)` — Promise helper for Image load

### Offline/connectivity functions
- `offlineDB` — IIFE namespace; methods: `saveProducts`, `getProducts`, `updateProductStock`, `addPendingSale`, `getPendingSales`, `removePendingSale`, `countPendingSales`, `saveCurrentUser`, `getCachedUser`
- `probeConnectivity()` — fetch `/api/ping` with 3s timeout; returns bool
- `setOnlineState(bool)` — sole place that changes `isOnline`; updates badge/banner/style
- `updateConnectionBadge()` — updates header indicator (online/offline/syncing + chip with pending count)
- `startProbeLoop()` / `stopProbeLoop()` — polls every 15s when offline

### Helpers
- `h(str)` — HTML escaping (XSS protection); use everywhere when rendering data from API
- `fPLN(grosz)` / `fTime(ts)` / `today()` — formatting
- `loading(on)` — shows/hides loading bar
- `showToast(msg, type)` — toast with auto-hide after 2.5s

## Mandatory rule for every frontend change

**After every code change** (`templates/index.html`, `static/app.js`, `static/sw.js`, CSS, fonts, icons) always do two things:

1. Bump `CACHE_NAME` in `static/sw.js` (e.g. `'sklepik-v19'` → `'sklepik-v20'`) — forces Chrome to fetch the new version
2. Bump the app version in `static/app.js` in the `<div class="app-version">` element (semver: patch for bug fixes, minor for new features)

Without this, users will see the old version from the service worker cache.

## Common tasks

**Force a PWA update after deployment:** change `CACHE_NAME` in `static/sw.js` (e.g. `'sklepik-v1'` → `'sklepik-v2'`). Chrome detects the sw.js change on every open (no-cache header).

**Change the app icon:** edit `generate_icons.py`, run `python3 -m venv /tmp/v && /tmp/v/bin/pip install pillow -q && /tmp/v/bin/python3 generate_icons.py`, then bump `CACHE_NAME` in `sw.js`.

**Add a new product category:** no code changes — categories are auto-generated from the `product.category` field.

**Change the colour scheme:** CSS custom properties in `:root` at the top of `templates/index.html`.

**Change quick payment amounts:** the `amts` array in `renderQuickAmounts()` in `static/app.js`.

**Add supported barcode formats:** the `formats` array in `decodeBarcode()` in `static/app.js`.

**Change the image size limit:** the `max` constant in `handleImg()` in `static/app.js` (default 300px).

**Add a new API endpoint:** follow the pattern in `app.py` — add a route with the `@login_required` decorator and optionally `@admin_required`.

**Change the offline polling interval:** the `15000` constant in `startProbeLoop()` in `static/app.js` (default 15s).

**Extend offline mode to another tab:** pattern — check `isOnline` before calling the API, on `e.isOffline` show an appropriate message or apply an IDB fallback.

## Environment variables

| Variable | Description | Required |
|---|---|---|
| `SECRET_KEY` | Session signing key (min. 32 chars) | **YES** |
| `DATABASE_URL` | Database URL (defaults to `sqlite:///data/sklepik.db`) | no |

## Hosting

- **PythonAnywhere** (recommended, free) — never sleeps, instructions in `DEPLOY.md`
- **Railway.app** (~$2-5/month) — never sleeps, automatic Docker deploy
- **Render.com** (free tier sleeps after 15 min) — automatic Docker deploy
