# Deployment Guide — Sklepik Szkolny

## Local with Docker (quickest start)

```bash
cp .env.example .env
# Edit .env and set SECRET_KEY to a random string

docker compose up --build
```

App available at: **http://localhost:5000**
Database stored in `./data/sklepik.db` (persists across restarts).

---

## PythonAnywhere — free hosting (recommended)

> A free account is sufficient for a school shop (up to 5 users).
> The app **never sleeps** — available 24/7.

### 1. Create an account

Go to [pythonanywhere.com](https://www.pythonanywhere.com) and sign up for a free account.

### 2. Upload files

In the **Files** tab, create a `sklepik` directory and upload:
- `app.py`
- `requirements.txt`
- `templates/login.html`
- `templates/index.html`

Or via the Bash console (if you have the repo on GitHub):
```bash
git clone https://github.com/YOUR-REPO/sklepik.git ~/sklepik
```

### 3. Install dependencies

In the **Consoles** tab open **Bash** and run:
```bash
cd ~/sklepik
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
mkdir -p data
```

> We use a virtualenv to avoid conflicts with other packages installed in the PythonAnywhere system (e.g. `dash`). If you see conflict warnings — you can ignore them as long as they concern packages outside this project.

### 4. Create a web app

**Web** tab → **Add a new web app** → **Manual configuration** → **Python 3.10**

In the **Code** section:
- Source code: `/home/YOUR_USERNAME/sklepik`
- Working directory: `/home/YOUR_USERNAME/sklepik`
- WSGI configuration file: click the link and replace the contents with:

```python
import sys
sys.path.insert(0, '/home/YOUR_USERNAME/sklepik')

from app import app as application
```

In the **Virtualenv** section:
- Enter the path to the venv: `/home/YOUR_USERNAME/sklepik/venv`

### 5. Set environment variables

In the **Environment variables** section add:
```
SECRET_KEY = paste-a-random-key-min-32-chars-here
```

Generate a key in the Bash console:
```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

### 6. Start the app

Click **Reload** in the Web tab.

App available at: **https://YOUR_USERNAME.pythonanywhere.com**

### 7. First login

- Username: `admin`
- Password: `admin`
- **Change the password immediately!** (Accounts tab → delete the old admin account and create a new one)

---

## Railway.app — paid ($2-5/month)

Railway auto-detects the Dockerfile.

```bash
# Install Railway CLI
npm install -g @railway/cli

# Log in and deploy
railway login
railway init
railway up
```

Add the `SECRET_KEY` environment variable in the Railway dashboard.

---

## Render.com

1. Connect your GitHub repository to Render
2. New Web Service → select the repo
3. Render will detect the Dockerfile automatically
4. Add `SECRET_KEY` in Environment Variables
5. Deploy

> Note: the free tier on Render **sleeps after 15 minutes of inactivity** — the first request after a pause will take ~30 seconds.

---

## Environment variables

| Variable | Description | Required |
|---|---|---|
| `SECRET_KEY` | Session signing key (min. 32 chars) | **YES** |
| `DATABASE_URL` | Database URL (defaults to SQLite) | no |

---

## Backup and restore

- **Backup**: log in as admin → **Backup** tab → **Full backup**
- **Restore**: same tab → Import → select the JSON file

