# Docker and Storage Configuration

## Recommended: SQLite

SQLite is for a single application instance. A Docker volume is not required to run it. Add a volume for data that must survive container removal or recreation:

```bash
docker run -d \
  --name codebuddy2api \
  --restart unless-stopped \
  -p 8001:8001 \
  -e CODEBUDDY_STORAGE_BACKEND=sqlite \
  -e CODEBUDDY_STORAGE_SQLITE_PATH=.codebuddy_data/storage.sqlite \
  -e CODEBUDDY_STORAGE_ENCRYPTION_KEY='replace-with-a-long-random-secret' \
  -e CODEBUDDY_STORAGE_IMPORT_LEGACY_FILES=false \
  ghcr.io/orangeboyChen/codebuddy2api:latest
```

- `CODEBUDDY_STORAGE_BACKEND=sqlite` enables SQLite.
- `CODEBUDDY_STORAGE_SQLITE_PATH` sets the database path; the default is `.codebuddy_data/storage.sqlite`.
- `CODEBUDDY_STORAGE_ENCRYPTION_KEY` is required and encrypts sensitive data. Keep it safe; losing it prevents decryption.
- `CODEBUDDY_STORAGE_IMPORT_LEGACY_FILES=false` disables legacy JSON import for a new deployment.
- Optional persistence: `-v codebuddy2api-data:/app/.codebuddy_data`. The SQLite database is stored there.

Open `http://127.0.0.1:8001/dashboard` after startup.

### SQLite environment variables

| Variable                                | Purpose                                                 | Example / default                   |
| --------------------------------------- | ------------------------------------------------------- | ----------------------------------- |
| `CODEBUDDY_STORAGE_BACKEND`             | Storage backend                                         | `sqlite`                            |
| `CODEBUDDY_STORAGE_SQLITE_PATH`         | SQLite file path                                        | `.codebuddy_data/storage.sqlite`    |
| `CODEBUDDY_STORAGE_ENCRYPTION_KEY`      | Encrypts sensitive data; required for database backends | Long random string                  |
| `CODEBUDDY_STORAGE_IMPORT_LEGACY_FILES` | Imports legacy files                                    | Set to `false` for a new deployment |

## Migrating legacy files

For an existing `.codebuddy_creds` directory or JSON configuration, omit `CODEBUDDY_STORAGE_IMPORT_LEGACY_FILES=false` on the first SQLite start and additionally mount the legacy credentials directory. After migration, set it to `false` and remove the `.codebuddy_creds` mount.

## PostgreSQL

Use PostgreSQL for multiple instances:

```bash
-e CODEBUDDY_STORAGE_BACKEND=pg \
-e DATABASE_URL='postgres://user:password@db:5432/codebuddy2api' \
-e CODEBUDDY_STORAGE_ENCRYPTION_KEY='replace-with-a-long-random-secret'
```

PostgreSQL does not need `.codebuddy_creds` except during legacy migration.

## Common runtime settings

| Variable                         | Purpose                      | Example / default             |
| -------------------------------- | ---------------------------- | ----------------------------- |
| `CODEBUDDY_API_ENDPOINT`         | Upstream CodeBuddy API URL   | `https://copilot.tencent.com` |
| `CODEBUDDY_AUTH_MODE`            | Upstream authentication mode | `auto` / `token`              |
| `CODEBUDDY_INTERNET_ENVIRONMENT` | Network environment          | `internal` / `ioa` / `public` |
| `CODEBUDDY_LOG_LEVEL`            | Server log level             | `INFO`                        |
| `CODEBUDDY_ADMIN_PASSKEY_RP_ID`  | Passkey hostname             | `example.com`                 |
