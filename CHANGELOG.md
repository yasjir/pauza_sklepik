# Changelog — Sklepik Szkolny

Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)

---

## [2.5.0] — 2026-03-16

### Added
- **Stock view — search and category filter** — the Magazyn tab now has a text search input (filters by name or barcode) and category chip buttons, matching the behaviour of the Sprzedaż tab.
- **Stock view — grouped by category** — products in Magazyn are now grouped under category headers (same layout as the seller view: rows of groups, each group a grid of cards sorted alphabetically).

---

## [2.4.0] — 2026-03-16

### Added
- **Date range report** — the Report tab now has two date pickers (Od / Do) instead of one. Both default to today, preserving the previous single-day behaviour. The API endpoint `GET /api/sales` accepts `date_from` and `date_to` query parameters.
- **Report pagination** — results are paginated (20 transactions per page) with numbered page buttons. Printing always includes all transactions regardless of the current page.

---

## [2.3.0] — 2026-03-16

### Changed
- **Product grid grouped by category** — products are now grouped under category headers with a visual separator. Within each group products are sorted alphabetically. Products already in the cart are promoted to a separate "🛒 W koszyku" section at the top.

---

## [2.2.0] — 2026-03-16

### Changed
- **JavaScript extracted to `static/app.js`** — all JS moved out of `templates/index.html` into a separate file for better maintainability and explicit service worker caching.

---

## [2.1.0] — 2026-03-16

### Added
- **In-cart highlight** — products already added to the cart are visually highlighted in the product grid (green border + cart badge showing quantity).

---

## [2.0.1] — 2026-03-15

### Fixed
- **Polish characters in buttons** — replaced `Fredoka One` (weight 400, no latin-ext) with `Fredoka` (variable 300–700, full latin-ext support). Characters such as ź, ę, ą, ś, ć are now rendered with the same font as the rest of the button text.
- **Button focus** — pressing Enter no longer re-triggers the focused button; added CSS `:focus-visible` and `e.preventDefault()` on relevant events.
- **PWA logout** — `/logout` excluded from service worker interception, ensuring correct redirect to the login page after logging out in standalone mode.

### Added
- Version label `2.0.0` displayed in the bottom-right corner of the app.

---

## [2.0.0] — 2026-02-24 / 2026-02-25

### Added
- **Barcode scanning** — BarcodeDetector API (native on Android) with ZXing fallback (@zxing/library 0.19.1, self-hosted). Camera accessible directly from the Stock tab when adding or editing a product.
- **Offline mode for sales** — IndexedDB (`sklepik-offline`) used as product cache, sales queue, and logged-in user cache. Sales work without internet; auto-sync on reconnect (polling every 15 s + `window.online` event).
- **PWA** — service worker (Cache-First for UI shell, Network-Only for `/api/*`), web manifest, 192×512 px icons. App installable from Chrome on Android as a standalone application.
- **Audit log** — `AuditLog` model in the database; records logins and critical admin actions (adding/removing products, users, data imports).
- **Login rate limiting** — max 10 attempts per minute per IP; 429 response on limit exceeded.
- **Forced password change** — `must_change_password` flag on the `User` model; new accounts and the default `admin/admin` account require a password change on first login.
- **Orientation lock** — portrait mode enforced via `screen.orientation.lock('portrait')` on tablets.
- **Self-hosted assets** — fonts (FredokaOne, Nunito latin/latin-ext) and ZXing stored locally in `static/`; no CDN dependency (required for offline support).
- **Docker** — `Dockerfile` and `docker-compose.yml` for local development.
- **DEPLOY.md** — deployment guide for PythonAnywhere and Render.

### Changed
- Architecture: migrated from purely offline version (`sklepik_pro.html`, localStorage) to Flask + SQLAlchemy backend with a shared database across multiple tablets.
- Login handled via `fetch()` instead of a full page reload.
- Product stock decremented locally in IndexedDB during offline sales; after reconnect `loadProducts()` fetches actual values from the server.

---

## [1.0.0] — 2026-02-24

### Added
- First backend version: Flask + SQLAlchemy + Flask-Login in a single `app.py` file.
- Models: `User`, `Product`, `Sale`, `SaleItem`.
- REST API: products, sales, backup (JSON export/import), users.
- Atomic sale processing — `with_for_update()` on product rows (no race condition across multiple tablets).
- Two user roles: admin (full access) and cashier (sales and report only).
- SPA frontend (`templates/index.html`) with tabs: Sales, Stock, Report, Accounts/Backup.
- Login page (`templates/login.html`).
- Prices stored as integers in grosz (1 PLN = 100).
- Product name and price snapshot in `SaleItem` — sales history unaffected by later product edits.
- Client-side image resize to max 300 px JPEG 85% before sending to the API.
- Backup format compatible with the original offline version (`sklepik_pro.html`).
