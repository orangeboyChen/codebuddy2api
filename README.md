# CodeBuddy2API

CodeBuddy2API is a `Next.js + TypeScript + Bun` application that proxies CodeBuddy behind an OpenAI-compatible `/v1/*` surface and ships a built-in browser admin console in the same deployable service.

This repository started from [Sliverkiss/CodeBuddy2api](https://github.com/Sliverkiss/CodeBuddy2api), but the current runtime is centered on the Next.js App Router rather than the original Python layout.

## Runtime Overview

- `/` serves the built-in admin console.
- `/v1/*` exposes the OpenAI-compatible API surface.
- `/codebuddy/auth/*` handles the CodeBuddy OAuth device/browser flow.
- `lib/server/*` contains shared runtime logic for config, credentials, proxying, and responses adaptation.
- `deploy/` keeps Docker Compose and Kubernetes examples for self-hosting.

## Project Layout

```text
CodeBuddy2api/
├── app/                           # Next.js pages and route handlers
│   ├── admin-api/                 # Internal JSON routes used by the admin UI
│   ├── api/settings/              # Password-protected settings API
│   ├── codebuddy/auth/            # OAuth start, poll, and callback routes
│   ├── health/                    # Health check route
│   └── v1/                        # OpenAI-compatible public API
├── app/admin/_components/         # Admin console UI and client state
├── lib/server/                    # Shared runtime helpers
├── tests/                         # Vitest test suite with coverage gate
├── config/                        # Persisted runtime config directory
├── deploy/                        # Compose and Kubernetes manifests
├── Dockerfile                     # Multi-stage standalone Next.js image build
└── README.md
```

## Local Development

Install dependencies and start the development server:

```bash
bun install
bun run dev
```

Development mode listens on `http://127.0.0.1:3000/`.

To test the production server locally:

```bash
bun run build
bun run start
```

The production start script binds to `0.0.0.0:8001`, so the admin console and API are available from `http://127.0.0.1:8001/`.

## Verification

Run the same checks expected by CI:

```bash
bun run lint
bun run format:check
bun run typecheck
bun run test:coverage
bun run build
```

Coverage must stay at or above `90%`.

## Deployment

### Docker Compose

```bash
cp .env.example .env
mkdir -p config .codebuddy_creds
docker compose -f deploy/docker-compose.yml up -d
```

The published image is `ghcr.io/orangeboychen/codebuddy2api:latest`.

### Docker Run

```bash
cp .env.example .env
mkdir -p config .codebuddy_creds
docker run -d \
  --name codebuddy2api \
  --restart unless-stopped \
  --env-file .env \
  -p 8001:8001 \
  -v "$(pwd)/config:/app/config" \
  -v "$(pwd)/.codebuddy_creds:/app/.codebuddy_creds" \
  ghcr.io/orangeboychen/codebuddy2api:latest
```

To build the image locally from the repository root:

```bash
docker build -t codebuddy2api .
```

### Kubernetes

```bash
kubectl apply -f deploy/k8s/codebuddy2api.yaml
kubectl port-forward service/codebuddy2api 8001:8001
```

The sample manifest provisions one `ConfigMap`, two `PersistentVolumeClaim` objects, one `Deployment`, and one `Service`.

## Credentials and Authentication

Credential files are stored as JSON under `.codebuddy_creds/`. The built-in console is the preferred way to create and manage them:

1. Start the service.
2. Open `http://127.0.0.1:3000/` in development or `http://127.0.0.1:8001/` in production.
3. Open the credentials tab.
4. Start the CodeBuddy authentication flow.
5. Complete the login in the opened CodeBuddy page.
6. Return to the console and refresh the credential list.

For upstream requests, `X-Domain`, `X-Enterprise-Id`, and `X-Tenant-Id` are derived from the active saved credential at request time. When a credential has no distinct tenant field, `X-Tenant-Id` falls back to the credential's `enterpriseId`.

If `CODEBUDDY_PASSWORD` is configured, protected API clients must send:

```text
Authorization: Bearer <password>
```

That password gate currently applies to `/v1/*` and `/api/settings`. The built-in console uses internal `/admin-api/*` routes rather than the public compatibility endpoints.

## API Surface

Public routes:

- `GET /health`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `GET /v1/credentials`
- `POST /v1/credentials`
- `GET /v1/credentials/current`
- `POST /v1/credentials/select`
- `POST /v1/credentials/auto`
- `POST /v1/credentials/toggle-rotation`
- `POST /v1/credentials/delete`

Internal routes used by the built-in console:

- `GET /api/settings`
- `POST /api/settings`
- `GET /codebuddy/auth/start`
- `POST /codebuddy/auth/poll`
- `GET /codebuddy/auth/callback`
- `GET /admin-api/settings`
- `POST /admin-api/settings`
- `GET /admin-api/stats`
- `GET /admin-api/credentials`
- `POST /admin-api/credentials`
- `GET /admin-api/credentials/current`
- `POST /admin-api/credentials/select`
- `POST /admin-api/credentials/auto`
- `POST /admin-api/credentials/toggle-rotation`
- `POST /admin-api/credentials/delete`
- `POST /admin-api/chat/completions`

## Client Examples

### TypeScript with the OpenAI SDK

```ts
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: 'any',
  baseURL: 'http://127.0.0.1:8001/v1',
});

const response = await client.chat.completions.create({
  model: 'glm-5.1',
  messages: [{ role: 'user', content: 'Hello, what is 2+2?' }],
});

console.log(response.choices[0]?.message?.content);
```

### Responses API

```ts
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: 'any',
  baseURL: 'http://127.0.0.1:8001/v1',
});

const response = await client.responses.create({
  model: 'gpt-5.5',
  input: 'Summarize the current admin runtime.',
});

console.log(response.output_text);
```

### curl

```bash
curl -X POST "http://127.0.0.1:8001/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-5.1",
    "messages": [{"role": "user", "content": "What model are you?"}],
    "stream": false
  }'
```

If password protection is enabled, add `-H "Authorization: Bearer <password>"`.

## Configuration

Settings are resolved in this order:

`config/config.json` > environment variables > built-in defaults

The repository includes both `.env.example` and `config/config.example.json`.

Common settings:

| Key                        | Default   | Description                                                       |
| -------------------------- | --------- | ----------------------------------------------------------------- |
| `CODEBUDDY_HOST`           | `0.0.0.0` | Stored runtime bind host metadata.                                |
| `CODEBUDDY_PORT`           | `8001`    | Stored runtime bind port metadata.                                |
| `CODEBUDDY_PASSWORD`       | empty     | Optional Bearer password for protected API routes.                |
| `CODEBUDDY_AUTH_MODE`      | `auto`    | `auto`, `api_key`, or `token`.                                    |
| `CODEBUDDY_API_KEY`        | empty     | Required when `CODEBUDDY_AUTH_MODE=api_key`.                      |
| `CODEBUDDY_LOG_LEVEL`      | `INFO`    | Runtime log level.                                                |
| `CODEBUDDY_ROTATION_COUNT` | `1`       | Rotate credentials every N requests. Use `0` to disable rotation. |

Additional runtime settings include `CODEBUDDY_API_ENDPOINT`, `CODEBUDDY_INTERNET_ENVIRONMENT`, `CODEBUDDY_CREDS_DIR`, `CODEBUDDY_MODELS`, and `CODEBUDDY_CONFIG_PATH`.

## Troubleshooting

- `No valid CodeBuddy credentials found`: complete the web login flow or place a valid credential JSON file under `.codebuddy_creds/`.
- `401` or `403` from protected routes: the `Authorization: Bearer <password>` header is missing or invalid.
- `401` or `403` from upstream CodeBuddy: the active credential or API key is invalid or expired.
- Login flow stalls: verify the service can reach the configured upstream endpoint.
- Settings do not persist: confirm `config/config.json` is writable inside the container or local workspace.

## License

See [LICENSE](./LICENSE) for details.
