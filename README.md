# CodeBuddy2API

Proxy CodeBuddy through OpenAI-compatible and Anthropic-compatible APIs, with a built-in admin console for credentials, access keys, usage, debug traces, and runtime settings.

> Forked from [Sliverkiss/CodeBuddy2api](https://github.com/Sliverkiss/CodeBuddy2api).

## Quick Start

```bash
docker run -d \
  --name codebuddy2api \
  --restart unless-stopped \
  -p 8001:8001 \
  -v "$(pwd)/.codebuddy_data:/app/.codebuddy_data" \
  -v "$(pwd)/.codebuddy_creds:/app/.codebuddy_creds" \
  ghcr.io/orangeboychen/codebuddy2api:latest
```

Open `http://127.0.0.1:8001/` after startup.

## Storage Backends

Persistence is now routed through a storage abstraction layer. Business modules do not read or write files directly.

- Default backend: `file`
- Optional database backends: `pg`, `sqlite`
- Backend selection:
  - explicit `CODEBUDDY_STORAGE_BACKEND=file|pg|sqlite`
  - explicit `CODEBUDDY_STORAGE_PERSISTENCE=file|pg|sqlite`
  - otherwise auto-switch to `pg` when `CODEBUDDY_STORAGE_PG_URL` or `DATABASE_URL` is set
  - otherwise fall back to `file`

### File Backend

The file backend now writes into a dedicated data directory instead of a `config/` tree:

- `.codebuddy_data/runtime.json`
- `.codebuddy_data/access-keys.json`
- `.codebuddy_data/debug-settings.json`
- `.codebuddy_data/debug-logs.json`
- `.codebuddy_data/usage-history.json`
- `.codebuddy_data/admin-auth.json`
- `.codebuddy_creds/*.json`

Usage records, debug records, and credential rotation checkpoints are flushed in
batches (at most once per second or after 100 pending records). File storage is
therefore intended for a single application instance; multiple instances can
overwrite each other's JSON documents.

Optional overrides:

- `CODEBUDDY_STORAGE_FILE_DIR` changes the file-backend data directory
- `CODEBUDDY_CONFIG_PATH` is kept only for legacy compatibility with the old runtime config file path

### Database Backends

When `pg` or `sqlite` storage is active, runtime persistence is stored in a database instead of local files.

- PostgreSQL uses `DATABASE_URL` or `CODEBUDDY_STORAGE_PG_URL` and the `codebuddy2api` schema
- SQLite uses `CODEBUDDY_STORAGE_SQLITE_PATH`; the default is `.codebuddy_data/storage.sqlite`
- `CODEBUDDY_STORAGE_ENCRYPTION_KEY` is required for either database backend and encrypts sensitive stored documents

In database mode, local files are not used for normal runtime persistence. Runtime
configuration, credentials, access keys, and debug settings can be read as an
optional one-time legacy import source during initialization. Historical usage
and debug log JSON files are not imported.

Usage and debug records are stored as append-only, indexed event rows with retention
pruning. PostgreSQL supports concurrent application instances. SQLite is a local,
single-instance backend. Credential rotation checkpoints remain eventually
consistent, so PostgreSQL replicas can occasionally select the same credential.

The application runs the bundled Drizzle migrations during database-backend
initialization, so deployments do not require a separate schema-creation step.
Keep legacy files available for the first application start so its idempotent
import can copy configuration, credentials, access keys, and admin state. Only
set `CODEBUDDY_STORAGE_IMPORT_LEGACY_FILES=false` after that start has completed.

## Run Locally

### Requirements

- Bun 1.3.14+
- Node.js 20+

### Development Mode

```bash
bun install
mkdir -p .codebuddy_data .codebuddy_creds
bun run dev
```

Then open `http://127.0.0.1:3000/`.

Use the admin console to complete the CodeBuddy OAuth flow or add credentials manually. Local settings and console data are stored under `.codebuddy_data/`; credentials are stored under `.codebuddy_creds/`.

### Production-like Local Run

```bash
bun install
mkdir -p .codebuddy_data .codebuddy_creds
bun run build
bun start
```

Then open `http://127.0.0.1:8001/`.

## Admin Console

The admin console uses stable routes and supports English, Japanese, and Simplified Chinese.

- console route: `http://<host>:8001/dashboard`
- login route: `http://<host>:8001/login`
- locale persistence: cookie-based, no locale path prefixes
- mobile tab bar supports horizontal scrolling
- authenticated admins can log out from the top-right action

### Admin Authentication

Admin authentication is optional.

- If no admin password and no passkey are configured, the admin console remains open.
- Once an admin password or passkey is configured, `/admin-api/*` requires the admin session cookie.
- Session transport: HTTP-only cookie
- Session TTL: 8 hours

### Password Login

- first-time bootstrap: `POST /admin-api/auth/setup`
- sign-in: `POST /admin-api/auth/session`
- sign-out: `DELETE /admin-api/auth/session`

### Passkey Login

Passkey endpoints are available under `/admin-api/auth/passkeys/*`.

- registration options: `POST /admin-api/auth/passkeys/registration/options`
- registration verify: `POST /admin-api/auth/passkeys/registration/verify`
- authentication options: `POST /admin-api/auth/passkeys/authentication/options`
- authentication verify: `POST /admin-api/auth/passkeys/authentication/verify`

Passkeys use WebAuthn and therefore depend on both a valid origin and a valid RP ID.

- `expectedOrigin` is derived from the live request protocol and host, including `x-forwarded-proto` and `x-forwarded-host` when present.
- `CODEBUDDY_ADMIN_PASSKEY_RP_ID` optionally overrides the WebAuthn RP ID used for admin passkey registration and authentication.
- If `CODEBUDDY_ADMIN_PASSKEY_RP_ID` is empty, the server falls back to the current request hostname with the port removed.
- The RP ID must be a hostname only, with no scheme, port, or path. Typical values are `example.com`, `admin.example.com`, or `localhost`.
- The RP ID must match the browser-visible origin domain or be a registrable parent-domain suffix accepted by the browser for that origin. If it does not match, passkey registration or authentication will fail.
- Production deployments should use HTTPS on the hostname the browser actually visits. If TLS terminates at a reverse proxy or ingress, forwarded host/protocol headers must reflect that public origin.
- `http://localhost` remains usable for local browser testing because browsers treat localhost as a secure-context exception. Plain HTTP on non-localhost hosts is not sufficient for WebAuthn.

## Public APIs

Base path:

```text
http://<host>:8001/v1
```

Supported endpoints:

- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/messages`
- `GET /v1/models`

### Authentication

- inference routes accept managed access keys
- send either `Authorization: Bearer <access-key>` or `x-api-key: <access-key>`
- `/admin-api/*` is controlled separately by the admin session cookie when admin auth is configured

## Runtime Settings

Settings resolve in this order:

1. persisted admin settings
2. environment variables
3. built-in defaults

Current persisted runtime settings:

- `CODEBUDDY_ADMIN_PASSKEY_RP_ID`
- `CODEBUDDY_API_ENDPOINT`
- `CODEBUDDY_AUTH_MODE`
- `CODEBUDDY_INTERNET_ENVIRONMENT`
- `CODEBUDDY_LOG_LEVEL`
- `CODEBUDDY_MODELS`

## Logging

The server now includes key runtime and security logging for upstream failures and admin-sensitive flows.

- debug snapshots redact tokens, cookies, API keys, auth headers, and user identifiers
- unreadable access-key storage is surfaced as a 503 instead of silently degrading

## Development

Primary quality gates:

```bash
bun run lint
bun run format:check
bun run typecheck
bun run test
bun run build
```

Targeted suites used during this refactor:

```bash
bun run test -- tests/admin/console.test.tsx
bun run test -- tests/server/runtime.test.ts
bun run test -- tests/server/debug-usage.test.ts
bun run test -- tests/server/access-keys-credentials.test.ts
bun run test -- tests/server/units.test.ts
```

## Deployment Notes

### Docker Compose

```bash
cp .env.example .env
mkdir -p .codebuddy_data .codebuddy_creds
docker compose -f deploy/docker-compose.yml up -d
```

### Kubernetes

```bash
kubectl apply -f deploy/k8s/codebuddy2api.yaml
kubectl port-forward service/codebuddy2api 8001:8001
```

## License

See [LICENSE](./LICENSE).
