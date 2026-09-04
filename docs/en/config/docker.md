# Docker and Storage Configuration

## SQLite (single instance)

SQLite is the recommended backend for a single instance. This command starts without a volume:

```bash
docker run -d --name codebuddy2api --restart unless-stopped -p 8001:8001 \
  -e CODEBUDDY_STORAGE_BACKEND=sqlite \
  -e CODEBUDDY_STORAGE_ENCRYPTION_KEY='replace-with-a-long-random-secret' \
  -e CODEBUDDY_STORAGE_IMPORT_LEGACY_FILES=false \
  ghcr.io/orangeboychen/codebuddy2api:latest
```

The database defaults to `/app/.codebuddy_data/storage.sqlite`. Add `-v codebuddy2api-data:/app/.codebuddy_data` if data must survive container removal or recreation.

Open `http://127.0.0.1:8001/dashboard` after startup.

## PostgreSQL (multiple instances)

Use PostgreSQL for multiple instances:

```bash
-e CODEBUDDY_STORAGE_BACKEND=pg \
-e DATABASE_URL='postgres://user:password@db:5432/codebuddy2api' \
-e CODEBUDDY_STORAGE_ENCRYPTION_KEY='replace-with-a-long-random-secret'
```

## Legacy file migration

If you have `.codebuddy_creds` or legacy JSON configuration, omit `CODEBUDDY_STORAGE_IMPORT_LEGACY_FILES=false` on the first database-backend startup and temporarily mount the legacy directory:

```bash
-v "$(pwd)/.codebuddy_creds:/app/.codebuddy_creds"
```

After migration, set `CODEBUDDY_STORAGE_IMPORT_LEGACY_FILES=false` and remove the legacy mount.

## Environment variables

| Variable                                | Purpose                                                          | Example / default                                |
| --------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------ |
| `CODEBUDDY_STORAGE_BACKEND`             | Storage backend                                                  | `file`, `sqlite`, or `pg`                        |
| `CODEBUDDY_STORAGE_SQLITE_PATH`         | SQLite file path                                                 | `.codebuddy_data/storage.sqlite`                 |
| `CODEBUDDY_STORAGE_ENCRYPTION_KEY`      | Encrypts sensitive database data; required for database backends | Long random string                               |
| `CODEBUDDY_STORAGE_IMPORT_LEGACY_FILES` | Imports legacy files                                             | Set to `false` for a new deployment              |
| `DATABASE_URL`                          | PostgreSQL connection string                                     | `postgres://user:password@db:5432/codebuddy2api` |
| `CODEBUDDY_API_ENDPOINT`                | Upstream CodeBuddy API URL                                       | `https://copilot.tencent.com`                    |
| `CODEBUDDY_AUTH_MODE`                   | Upstream authentication mode                                     | `auto` / `token`                                 |
| `CODEBUDDY_INTERNET_ENVIRONMENT`        | Network environment                                              | `internal` / `ioa` / `public`                    |
| `CODEBUDDY_LOG_LEVEL`                   | Server log level                                                 | `INFO`                                           |
| `CODEBUDDY_ADMIN_PASSKEY_RP_ID`         | Admin passkey hostname                                           | `example.com`                                    |
