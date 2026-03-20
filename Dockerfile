FROM python:3.11-slim

WORKDIR /app

# Copy dependencies and install them first (Docker layer cache)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the application
COPY . .

# Directory for the SQLite database
RUN mkdir -p /app/data

EXPOSE 6060

# gunicorn: 2 workers are enough for a school shop
CMD ["gunicorn", "--bind", "0.0.0.0:6060", "--workers", "2", "--timeout", "60", "app:app"]
