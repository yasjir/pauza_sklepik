# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Opis projektu

Sklepik Szkolny — system POS (punkt sprzedaży) dla szkoły. Docelowo działa na tabletach Samsung Galaxy Tab S10 FE. Cały interfejs i kod są **po polsku**.

Projekt istnieje w dwóch wersjach:
- `sklepik_pro.html` — oryginalna statyczna wersja offline (localStorage, brak serwera)
- **wersja z backendem** (aktywna) — Flask + SQLAlchemy, wspólna baza dla wielu tabletów, **z trybem offline dla sprzedaży**

Wersja z backendem działa jako **PWA (Progressive Web App)** — instalowalna z Chrome na Androidzie, działa w pełni offline po pierwszej wizycie (service worker cachuje cały UI shell).

## Jak uruchomić

```bash
# Lokalnie przez Docker (zalecane)
cp .env.example .env        # ustaw SECRET_KEY
docker compose up --build   # http://localhost:5000

# Lokalnie bez Dockera
pip install -r requirements.txt
flask run
```

Pierwsze logowanie: **admin / admin** — zmień hasło po uruchomieniu.

Szczegółowa instrukcja deployu na PythonAnywhere i Render: `DEPLOY.md`.

## Architektura

### Backend — `app.py` (jeden plik)

Flask + SQLAlchemy + Flask-Login. Celowo wszystko w jednym pliku dla czytelności.

**Modele bazy danych:**
- `User` — id, username, password_hash, is_admin
- `Product` — id, name, emoji, price (grosze), stock, barcode, category, img (base64)
- `Sale` — id, ts (ms timestamp), date (YYYY-MM-DD), total, paid, user_id
- `SaleItem` — id, sale_id, product_id, name, emoji, qty, price (snapshot w momencie sprzedaży)

**Baza danych:**
- Domyślnie SQLite w `./data/sklepik.db`
- Nadpisywalna przez zmienną środowiskową `DATABASE_URL` (PostgreSQL/MySQL)
- `init_db()` tworzy tabele i konto `admin/admin` przy pierwszym starcie

### Frontend — `templates/index.html`

SPA (vanilla JS). Bazuje na `sklepik_pro.html` z następującymi zmianami:
- `localStorage` zastąpiony przez `fetch()` do REST API
- Koszyk i numpad zostają **client-side** (nie wymagają synchronizacji)
- Skanowanie kodów kreskowych — client-side (kamera, BarcodeDetector + ZXing)
- Nowa zakładka **Konta** (widoczna tylko dla adminów)
- Zakładki Magazyn/Backup/Konta ukryte dla sprzedawców
- **Tryb offline** — sprzedaż działa bez internetu, auto-sync po powrocie połączenia
- **PWA** — rejestruje service worker przy starcie; toast gdy dostępna aktualizacja

### Strona logowania — `templates/login.html`

Minimalistyczna, pasuje stylem do głównej apki. Używa `fetch()` do `POST /login`.

### Zasoby statyczne — `static/`

Wszystkie zewnętrzne zależności są **self-hosted** (brak CDN) — warunek konieczny dla offline:

```
static/
├── manifest.json          # Manifest PWA
├── sw.js                  # Service worker (serwowany przez /sw.js w app.py)
├── fonts/
│   ├── FredokaOne-Regular.woff2
│   ├── Nunito-latin.woff2       # subset latin (zawiera ó)
│   └── Nunito-latin-ext.woff2  # subset latin-ext (ą, ę, ś, ł, ź, ż, ć, ń)
├── zxing/
│   └── zxing.min.js       # @zxing/library 0.19.1 UMD (jsDelivr)
└── icons/
    ├── icon-192.png
    └── icon-512.png
```

`generate_icons.py` — jednorazowy skrypt (wymaga Pillow) do regeneracji ikon PWA.

## PWA i instalacja na tablecie

Aplikacja spełnia kryteria PWA — Chrome na Androidzie proponuje "Dodaj do ekranu głównego" po zalogowaniu. Po instalacji uruchamia się bez paska przeglądarki (`display: standalone`).

**Instalacja na Samsung Galaxy Tab S10 FE:**
1. Otwórz Chrome → wejdź na URL aplikacji → zaloguj się
2. Chrome pokaże baner "Dodaj do ekranu głównego" (lub menu ⋮ → Dodaj)
3. Gotowe — aplikacja działa w pełni offline od tej chwili

**Service worker (`static/sw.js`):**
- Strategia Cache-First dla UI shell: `/app`, `/login`, fonty, ZXing
- Network-Only dla `/api/*` — IndexedDB obsługuje offline dla danych (patrz niżej)
- `CACHE_NAME = 'sklepik-v1'` — zmień przy każdym deploymencie żeby wymusić aktualizację
- `Service-Worker-Allowed: /` header w route `/sw.js` — umożliwia scope na całą aplikację mimo serwowania z `/static/`

**Aktualizacja po deploymencie:** zmień `CACHE_NAME` w `static/sw.js` (`v1` → `v2` itd.). Chrome wykryje zmianę przy następnym otwarciu, zainstaluje nową wersję w tle i pokaże toast użytkownikowi.

---

## Tryb offline

Aplikacja obsługuje przerwy w połączeniu internetowym na dwóch poziomach:

**Poziom 1 — Service Worker (UI shell):** HTML, JS, CSS, fonty, ZXing cachowane lokalnie — aplikacja ładuje się bez sieci nawet przy zimnym starcie tabletu.

**Poziom 2 — IndexedDB (dane):** produkty, kolejka sprzedaży, sesja użytkownika.

**Co działa offline:** tylko zakładka Sprzedaż

**Co wymaga internetu:** logowanie (pierwsze), Magazyn, Raporty, Konta/Backup

**Mechanizm IndexedDB:**
- `offlineDB` (IndexedDB `sklepik-offline`, v1) — 3 stores:
  - `products` — cache produktów z API (z obrazami base64); aktualizowany przy każdym `loadProducts()`
  - `pending_sales` — kolejka sprzedaży do synchronizacji (autoIncrement `localId`)
  - `user` — cache zalogowanego użytkownika (umożliwia restart tabletu offline)
- `probeConnectivity()` — fetch `/api/ping` z timeoutem 3s; dowolna odpowiedź HTTP = online
- `setOnlineState(bool)` — jedyne miejsce zmiany stanu; aktualizuje badge w nagłówku, baner na stronie Sprzedaży, styl przycisku Zatwierdź
- Gdy offline: sprzedaż trafia do `pending_sales` w IndexedDB, stany produktów dekrementowane lokalnie
- Auto-sync: sondowanie co 15s gdy offline + `window.online` event → `syncPendingSales()`
- `syncPendingSales()` — iteruje kolejkę, POST do `/api/sales`, przy błędzie serwera (brak stanu) zachowuje w kolejce z `alert()` dla kasjera

**Ważne dla offline:**
- Stany produktów w IndexedDB są dekrementowane lokalnie po każdej sprzedaży offline — kolejne sprzedaże w tej samej sesji offline widzą aktualny stan
- Po powrocie online `loadProducts()` pobiera rzeczywiste stany z serwera
- Restart tabletu/przeglądarki offline: produkty i kolejka sprzedaży przeżywają restart (IndexedDB persystuje); cached user pozwala uruchomić app bez logowania

## API Endpointy

Wszystkie (poza `/api/ping`) wymagają aktywnej sesji (401 → redirect do loginu). Endpointy z `[admin]` wymagają `is_admin=True` (403 jeśli brak).

| Metoda | Ścieżka | Opis |
|---|---|---|
| GET | `/api/ping` | Sprawdzenie łączności — **bez autoryzacji** |
| GET | `/sw.js` | Service worker PWA — `no-cache`, `Service-Worker-Allowed: /` |
| GET | `/manifest.json` | Manifest PWA |
| GET | `/api/me` | Info o zalogowanym użytkowniku |
| GET | `/api/products` | Lista wszystkich produktów |
| POST | `/api/products` | Dodaj produkt `[admin]` |
| PUT | `/api/products/<id>` | Edytuj produkt `[admin]` |
| DELETE | `/api/products/<id>` | Usuń produkt `[admin]` |
| POST | `/api/products/<id>/restock` | Uzupełnij stan `[admin]` |
| GET | `/api/sales?date=YYYY-MM-DD` | Transakcje (opcjonalnie filtr po dacie) |
| POST | `/api/sales` | Zatwierdź sprzedaż (atomicznie sprawdza stock) |
| GET | `/api/export` | Pobierz pełny backup JSON `[admin]` |
| GET | `/api/export/products` | Pobierz tylko produkty JSON `[admin]` |
| POST | `/api/import` | Wgraj backup JSON (nadpisuje dane) `[admin]` |
| GET | `/api/users` | Lista użytkowników `[admin]` |
| POST | `/api/users` | Dodaj użytkownika `[admin]` |
| DELETE | `/api/users/<id>` | Usuń użytkownika `[admin]` |
| PUT | `/api/users/<id>/password` | Zmień hasło (admin lub własne) |

## Kluczowe zasady implementacyjne

**Ceny:** zawsze integer w groszach (1 zł = 100). Używaj `fPLN(grosz)` do wyświetlania.

**Timestamp:** serwer nadaje czas sprzedaży (`datetime.now(timezone.utc)`), nie klient. Ważne przy wielu tabletach. Sprzedaże offline mają `ts_local` (czas lokalny) w IndexedDB, ale serwer nada własny `ts` przy synchronizacji.

**Zdjęcia:** resize do max 300px JPEG 85% odbywa się **po stronie JS** (`handleImg()` w index.html) przed wysłaniem do API. Wynik to ~20-40 KB base64 na produkt. Serwer przechowuje base64 w kolumnie `img TEXT`. Obrazy są też w cache IndexedDB — UI działa offline z obrazami.

**Atomiczna sprzedaż:** `POST /api/sales` używa `with_for_update()` na wierszach produktów — dwa tablety nie mogą jednocześnie sprzedać tego samego towaru ponad stan.

**Obsługa błędów sieci w `api()`:** wrapper używa `AbortController` z timeoutem 8s. Przy `TypeError` lub `AbortError` rzuca błąd z flagą `err.isOffline = true`. Wywołujący mogą sprawdzić tę flagę i zastosować fallback offline zamiast wyświetlać error.

**Role użytkowników:**
- `is_admin=True` → dostęp do wszystkich zakładek i endpointów
- `is_admin=False` (sprzedawca) → tylko Sprzedaż i Raport; zakładki Magazyn/Backup/Konta ukryte

**Format backupu:** kompatybilny z oryginalną wersją statyczną (`sklepik_pro.html`). Można importować dane z localStorage przez eksport z oryginalnej apki.

## Funkcje JS w templates/index.html

### Główne funkcje aplikacji
- `init()` — sprawdza łączność i sesję (`GET /api/me` z fallbackiem na IDB), ładuje produkty, inicjalizuje UI, uruchamia startup sync
- `api(method, path, body)` — wrapper na fetch; AbortController 8s; `err.isOffline=true` przy braku sieci; auto-recovery `setOnlineState(true)` przy udanej odpowiedzi
- `loadProducts()` — online: fetch z API + zapis do IDB; offline: czyta z IDB
- `finalize()` — online: POST `/api/sales`; offline: `saveOfflineSale()`
- `saveOfflineSale(cart, paid, total)` — zapis do kolejki IDB + lokalna dekrementacja stanów
- `syncPendingSales()` — iteruje `pending_sales` w IDB, POST do `/api/sales`, alert przy błędach serwera
- `saveProduct()` — POST lub PUT do API w zależności od `editingId`
- `restock(id)` — POST do `/api/products/<id>/restock`
- `delProduct(id)` — DELETE do API
- `renderReport()` — pobiera `GET /api/sales?date=...` i renderuje tabelę; toast przy offline
- `doImport()` — wysyła plik jako JSON do `POST /api/import`
- `handleImg(input)` — resize zdjęcia client-side do max 300px przed wysłaniem
- `decodeBarcode(file)` — BarcodeDetector API lub ZXing fallback

### Funkcje offline/connectivity
- `offlineDB` — IIFE namespace; metody: `saveProducts`, `getProducts`, `updateProductStock`, `addPendingSale`, `getPendingSales`, `removePendingSale`, `countPendingSales`, `saveCurrentUser`, `getCachedUser`
- `probeConnectivity()` — fetch `/api/ping` z timeout 3s; zwraca bool
- `setOnlineState(bool)` — jedyne miejsce zmiany `isOnline`; aktualizuje badge/baner/styl
- `updateConnectionBadge()` — aktualizuje wskaźnik w nagłówku (online/offline/syncing + chip z liczbą oczekujących)
- `startProbeLoop()` / `stopProbeLoop()` — sondowanie co 15s gdy offline

## Typowe zadania

**Wymuś aktualizację PWA po deploymencie:** zmień `CACHE_NAME` w `static/sw.js` (np. `'sklepik-v1'` → `'sklepik-v2'`). Chrome wykrywa zmianę sw.js przy każdym otwarciu (nagłówek `no-cache`).

**Zmień ikonę aplikacji:** edytuj `generate_icons.py`, uruchom `python3 -m venv /tmp/v && /tmp/v/bin/pip install pillow -q && /tmp/v/bin/python3 generate_icons.py`, potem bump `CACHE_NAME` w `sw.js`.

**Dodaj nową kategorię produktu:** brak zmian w kodzie — kategorie są auto-generowane z pola `product.category`.

**Zmień schemat kolorów:** CSS custom properties w `:root` na początku `templates/index.html`.

**Zmień szybkie kwoty płatności:** tablica `amts` w funkcji `renderQuickAmounts()` w `templates/index.html`.

**Dodaj obsługiwane formaty kodów kreskowych:** tablica `formats` w `decodeBarcode()` w `templates/index.html`.

**Zmień limit rozmiaru zdjęcia:** stała `max` w `handleImg()` w `templates/index.html` (domyślnie 300px).

**Dodaj nowy endpoint API:** wzorzec w `app.py` — dodaj route z dekoratorem `@login_required` i opcjonalnie `@admin_required`.

**Zmień interwał sondowania offline:** stała `15000` w `startProbeLoop()` w `templates/index.html` (domyślnie 15s).

**Rozszerz tryb offline na inną zakładkę:** wzorzec — sprawdź `isOnline` przed wywołaniem API, przy `e.isOffline` pokaż stosowny komunikat lub zastosuj fallback z IDB.

## Zmienne środowiskowe

| Zmienna | Opis | Wymagana |
|---|---|---|
| `SECRET_KEY` | Klucz do podpisywania sesji Flask (min. 32 znaki) | **TAK** |
| `DATABASE_URL` | URL bazy danych (domyślnie `sqlite:///data/sklepik.db`) | nie |

## Hosting

- **PythonAnywhere** (zalecany, darmowy) — nie zasypia, instrukcja w `DEPLOY.md`
- **Railway.app** (~$2-5/mies.) — nie zasypia, automatyczny Docker deploy
- **Render.com** (darmowy tier zasypia po 15 min) — automatyczny Docker deploy
