# Docker and Storage Configuration

## Recommended: SQLite

SQLite is for a single application instance. Runtime data, including credentials, access keys, admin state, usage, and debug logs, is stored in the database, so only `.codebuddy_data` needs to be mounted:

```bash
docker run -d \
  --name codebuddy2api \
  --restart unless-stopped \
  -p 8001:8001 \
  -e CODEBUDDY_STORAGE_BACKEND=sqlite \
  -e CODEBUDDY_STORAGE_SQLITE_PATH=.codebuddy_data/storage.sqlite \
  -e CODEBUDDY_STORAGE_ENCRYPTION_KEY='replace-with-a-long-random-secret' \
  -e CODEBUDDY_STORAGE_IMPORT_LEGACY_FILES=false \
  -v "$(pwd)/.codebuddy_data:/app/.codebuddy_data" \
  ghcr.io/orangeboyChen/codebuddy2api:latest
```

- `CODEBUDDY_STORAGE_BACKEND=sqlite` enables SQLite.
- `CODEBUDDY_STORAGE_SQLITE_PATH` sets the database path; the default is `.codebuddy_data/storage.sqlite`.
- `CODEBUDDY_STORAGE_ENCRYPTION_KEY` is required and encrypts sensitive data. Keep it safe; losing it prevents decryption.
- `CODEBUDDY_STORAGE_IMPORT_LEGACY_FILES=false` disables legacy JSON import for a new deployment.
- `.codebuddy_data` is the only persistent volume needed for a new SQLite deployment.

Open `http://127.0.0.1:8001/dashboard` after startup.

## Migrating legacy files

For an existing `.codebuddy_creds` directory or JSON configuration, omit `CODEBUDDY_STORAGE_IMPORT_LEGACY_FILES=false` on the first SQLite start and mount both directories. After migration, set it to `false` and remove the `.codebuddy_creds` mount.

## PostgreSQL

Use PostgreSQL for multiple instances:

```bash
-e CODEBUDDY_STORAGE_BACKEND=pg \
-e DATABASE_URL='postgres://user:password@db:5432/codebuddy2api' \
-e CODEBUDDY_STORAGE_ENCRYPTION_KEY='replace-with-a-long-random-secret'
```

PostgreSQL does not need `.codebuddy_creds` except during legacy migration.

## Common runtime settings

`CODEBUDDY_API_ENDPOINT`, `CODEBUDDY_AUTH_MODE`, `CODEBUDDY_INTERNET_ENVIRONMENT`, `CODEBUDDY_LOG_LEVEL`, and `CODEBUDDY_ADMIN_PASSKEY_RP_ID` can be set as environment variables or in the admin console.
