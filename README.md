# CodeBuddy2API

[![CI](https://github.com/orangeboyChen/codebuddy2api/actions/workflows/ci-main.yml/badge.svg?branch=main)](https://github.com/orangeboyChen/codebuddy2api/actions/workflows/ci-main.yml)
[![codecov](https://codecov.io/gh/orangeboyChen/codebuddy2api/graph/badge.svg?token=SJP5CBSQ16)](https://codecov.io/gh/orangeboyChen/codebuddy2api)

Proxy CodeBuddy with OpenAI-compatible and Anthropic-compatible APIs for Codex, Claude Code, and standard SDK clients.

<p align="center">
  <img src="./.github/images/codebuddy2api-social.jpg" alt="CodeBuddy2API" width="600" />
</p>

CodeBuddy2API is a self-hosted gateway with a web-based admin console for managing credentials, access keys, usage, account status, debug traces, and runtime settings.

This project is a substantial refactor of [Sliverkiss/CodeBuddy2api](https://github.com/Sliverkiss/CodeBuddy2api), with a redesigned admin console, multi-protocol API support, and flexible storage backends.

## Quick Start

The following command starts a single-instance deployment with SQLite:

```bash
docker run -d \
  --name codebuddy2api \
  --restart unless-stopped \
  -p 8001:8001 \
  -v codebuddy2api-data:/app/.codebuddy_data \
  -e CODEBUDDY_STORAGE_BACKEND=sqlite \
  -e CODEBUDDY_STORAGE_ENCRYPTION_KEY='replace-with-a-long-random-secret' \
  -e CODEBUDDY_STORAGE_IMPORT_LEGACY_FILES=false \
  ghcr.io/orangeboychen/codebuddy2api:latest
```

Open `http://127.0.0.1:8001/dashboard`, complete CodeBuddy authentication or add a credential manually, then create an access key for your clients.

## API Compatibility

The gateway exposes these endpoints under `/v1`:

- `POST /v1/chat/completions` — OpenAI Chat Completions
- `POST /v1/responses` — OpenAI Responses
- `POST /v1/messages` — Anthropic Messages
- `GET /v1/models` — models available to the requesting access key

Authenticate inference requests with either header:

```http
Authorization: Bearer <access-key>
```

```http
x-api-key: <access-key>
```

Example OpenAI-compatible request:

```bash
curl http://127.0.0.1:8001/v1/chat/completions \
  -H 'Authorization: Bearer <access-key>' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "<model>",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

## Storage

- `file` — zero-configuration storage for a single instance
- `sqlite` — encrypted SQLite storage for a single instance
- `pg` — PostgreSQL storage for multiple instances

Database backends require `CODEBUDDY_STORAGE_ENCRYPTION_KEY`. Set `DATABASE_URL` for PostgreSQL or `CODEBUDDY_STORAGE_SQLITE_PATH` for SQLite.

## Documentation

[Read the documentation](https://orangeboychen.github.io/codebuddy2api/)

## License

See [LICENSE](./LICENSE).
