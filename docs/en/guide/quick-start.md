# Quick Start

## Docker with SQLite

```bash
docker run -d --name codebuddy2api --restart unless-stopped -p 8001:8001 \
  -e CODEBUDDY_STORAGE_BACKEND=sqlite \
  -e CODEBUDDY_STORAGE_ENCRYPTION_KEY='replace-with-a-long-random-secret' \
  -e CODEBUDDY_STORAGE_IMPORT_LEGACY_FILES=false \
  -v "$(pwd)/.codebuddy_data:/app/.codebuddy_data" \
  ghcr.io/orangeboychen/codebuddy2api:latest
```

Open `http://127.0.0.1:8001/dashboard`. SQLite is recommended for a single instance; use PostgreSQL for multiple instances.

## Local CodeBuddy2API

For local development, run `bun install`, create `.codebuddy_data` and `.codebuddy_creds`, then run `bun run dev`. Open `http://127.0.0.1:3000/dashboard`.

## Local documentation

From the repository root, run `bun install --cwd docs`, then `bun run docs:dev`. The documentation site is usually at `http://127.0.0.1:5173/codebuddy2api/`.

## First-use checklist

1. Authorize a CodeBuddy account in **Credentials**.
2. Refresh quota and confirm the model in **Account Status**.
3. Create an API key in **Credentials**.
4. Send a test message in **API Test**.
5. Configure your client with the `/v1` endpoint and API key.
