# Instrukcja wdrożenia — Sklepik Szkolny

## Lokalnie z Docker (najszybszy start)

```bash
cp .env.example .env
# Edytuj .env i ustaw SECRET_KEY na losowy ciąg znaków

docker compose up --build
```

Apka dostępna pod: **http://localhost:5000**
Dane bazy w katalogu `./data/sklepik.db` (persystują przez restartami).

---

## PythonAnywhere — darmowy hosting (zalecany)

> Darmowe konto wystarczy dla szkolnego sklepiku (max 5 użytkowników).
> Apka **nie zasypia** — jest dostępna całą dobę.

### 1. Zarejestruj konto

Wejdź na [pythonanywhere.com](https://www.pythonanywhere.com) i utwórz darmowe konto.

### 2. Wgraj pliki

W zakładce **Files** utwórz katalog `sklepik` i wgraj:
- `app.py`
- `requirements.txt`
- `templates/login.html`
- `templates/index.html`

Albo przez konsolę Bash (jeśli masz repo na GitHubie):
```bash
git clone https://github.com/TWOJE-REPO/sklepik.git ~/sklepik
```

### 3. Zainstaluj zależności

W zakładce **Consoles** otwórz **Bash** i wykonaj:
```bash
cd ~/sklepik
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
mkdir -p data
```

> Używamy virtualenv żeby uniknąć konfliktów z innymi pakietami zainstalowanymi w systemie PythonAnywhere (np. `dash`). Jeśli pojawią się ostrzeżenia o konfliktach — możesz je zignorować, o ile dotyczą pakietów spoza tego projektu.

### 4. Utwórz aplikację webową

Zakładka **Web** → **Add a new web app** → **Manual configuration** → **Python 3.10**

W sekcji **Code**:
- Source code: `/home/TWOJA_NAZWA/sklepik`
- Working directory: `/home/TWOJA_NAZWA/sklepik`
- WSGI configuration file: kliknij link i zastąp zawartość tym:

```python
import sys
sys.path.insert(0, '/home/TWOJA_NAZWA/sklepik')

from app import app as application
```

W sekcji **Virtualenv**:
- Wpisz ścieżkę do venv: `/home/TWOJA_NAZWA/sklepik/venv`

### 5. Ustaw zmienne środowiskowe

W sekcji **Environment variables** dodaj:
```
SECRET_KEY = wklej-tutaj-losowy-klucz-min-32-znaki
```

Wygeneruj klucz w konsoli Bash:
```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

### 6. Uruchom

Kliknij **Reload** w zakładce Web.

Apka dostępna pod: **https://TWOJA_NAZWA.pythonanywhere.com**

### 7. Pierwsze logowanie

- Login: `admin`
- Hasło: `admin`
- **Natychmiast zmień hasło!** (zakładka Konta → usuń stare konto admin i utwórz nowe)

---

## Railway.app — płatny ($2-5/mies.)

Railway automatycznie wykrywa Dockerfile.

```bash
# Zainstaluj Railway CLI
npm install -g @railway/cli

# Zaloguj się i deploy
railway login
railway init
railway up
```

W panelu Railway dodaj zmienną środowiskową `SECRET_KEY`.

---

## Render.com

1. Połącz repozytorium GitHub z Render
2. New Web Service → wybierz repo
3. Render wykryje Dockerfile automatycznie
4. Dodaj `SECRET_KEY` w Environment Variables
5. Deploy

> Uwaga: darmowy tier na Render **zasypia po 15 min bezczynności** — pierwsze otwarcie po przerwie zajmie ~30 sekund.

---

## Zmienne środowiskowe

| Zmienna | Opis | Wymagana |
|---|---|---|
| `SECRET_KEY` | Klucz do podpisywania sesji (min. 32 znaki) | **TAK** |
| `DATABASE_URL` | URL bazy danych (domyślnie SQLite) | nie |

---

## Backup i przywracanie danych

- **Backup**: zaloguj się jako admin → zakładka **Backup** → **Pełny backup**
- **Przywracanie**: ta sama zakładka → Import → wybierz plik JSON

Format backupu jest kompatybilny z oryginalną statyczną wersją (`sklepik_pro.html`).
Możesz zaimportować stare dane z localStorage eksportując je przez oryginalną apkę.
