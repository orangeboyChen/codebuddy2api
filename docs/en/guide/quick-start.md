# Quick Start

## Docker with SQLite

```bash
docker run -d --name codebuddy2api --restart unless-stopped -p 8001:8001 \
  -e CODEBUDDY_STORAGE_BACKEND=sqlite \
  -e CODEBUDDY_STORAGE_ENCRYPTION_KEY='replace-with-a-long-random-secret' \
  -e CODEBUDDY_STORAGE_IMPORT_LEGACY_FILES=false \
  ghcr.io/orangeboychen/codebuddy2api:latest
```

Open `http://127.0.0.1:8001/dashboard`. SQLite is recommended for a single instance; use PostgreSQL for multiple instances.

## First-use checklist

1. Authorize a CodeBuddy account in **Credentials**.
2. Refresh quota and confirm the model in **Account Status**.
3. Create an API key in **Credentials**.
4. Send a test message in **API Test**.
5. Configure your client with the `/v1` endpoint and API key.
