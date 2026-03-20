# Sklepik Szkolny 🛒

A lightweight **point-of-sale web app** built for a school shop. Runs on Samsung Galaxy Tab S10 FE tablets, installable as a PWA, and keeps selling even when the internet goes down.

## Features

- **Sales** — tap products to add them to the cart, enter the payment amount, confirm with one tap (or Enter on a keyboard)
- **Barcode scanning** — via device camera (BarcodeDetector API + ZXing fallback) or a hardware USB/Bluetooth scanner
- **Stock management** — restock products, edit details, attach photos
- **Reports** — daily and date-range sales summaries with print support
- **Multi-device** — shared database; multiple tablets work simultaneously without stock conflicts (atomic transactions)
- **Offline mode** — the Sales tab works without internet; queued sales sync automatically on reconnect
- **PWA** — installable from Chrome on Android; works as a standalone app without a browser bar
- **User roles** — admin (full access) and cashier (sales + reports only)
- **Audit log** — records logins and all critical admin actions

## Tech stack

| Layer | Technology |
|---|---|
| Backend | Python · Flask · SQLAlchemy · Flask-Login |
| Frontend | Vanilla JS SPA · IndexedDB · Service Worker |
| Database | SQLite (default) · PostgreSQL / MySQL (via `DATABASE_URL`) |
| Hosting | PythonAnywhere (free) · Railway · Render · Docker |

## Quick start

```bash
cp .env.example .env   # set SECRET_KEY
docker compose up --build
```

Open **http://localhost:6060** and log in with `admin / admin`.
You will be prompted to change the password on first login.

See [DEPLOY.md](DEPLOY.md) for full deployment instructions (PythonAnywhere, Railway, Render).


## Project structure

```
sklepik/
├── app.py              # Entire backend (Flask, models, API)
├── templates/
│   ├── index.html      # Main SPA shell (HTML + CSS)
│   └── login.html      # Login page
├── static/
│   ├── app.js          # All frontend JavaScript
│   ├── sw.js           # Service worker (PWA offline)
│   ├── manifest.json   # PWA manifest
│   ├── fonts/          # Self-hosted Fredoka + Nunito
│   └── zxing/          # Self-hosted ZXing barcode library
├── DEPLOY.md           # Deployment guide
└── CHANGELOG.md        # Version history
```

## Environment variables

| Variable | Description | Required |
|---|---|---|
| `SECRET_KEY` | Session signing key (min. 32 chars) | **yes** |
| `DATABASE_URL` | Database URL (defaults to SQLite) | no |

---

*Developed with the assistance of [Claude](https://claude.ai) by Anthropic.*
