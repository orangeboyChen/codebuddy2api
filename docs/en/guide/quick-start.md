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

## Local documentation

From the repository root, run `bun install`, `bun install --cwd docs`, then `bun run docs:dev`.
