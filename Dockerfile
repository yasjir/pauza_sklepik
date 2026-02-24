FROM python:3.11-slim

WORKDIR /app

# Skopiuj zależności i zainstaluj je najpierw (cache Dockera)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Skopiuj resztę aplikacji
COPY . .

# Katalog na bazę danych SQLite
RUN mkdir -p /app/data

EXPOSE 6060

# gunicorn: 2 workery wystarczą dla szkolnego sklepiku
CMD ["gunicorn", "--bind", "0.0.0.0:6060", "--workers", "2", "--timeout", "60", "app:app"]
