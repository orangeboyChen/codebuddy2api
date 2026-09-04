# CodeBuddy2API

[![CI](https://github.com/orangeboyChen/codebuddy2api/actions/workflows/ci-main.yml/badge.svg?branch=main)](https://github.com/orangeboyChen/codebuddy2api/actions/workflows/ci-main.yml)
[![codecov](https://codecov.io/gh/orangeboyChen/codebuddy2api/graph/badge.svg?token=SJP5CBSQ16)](https://codecov.io/gh/orangeboyChen/codebuddy2api)

CodeBuddy2API is a self-hosted CodeBuddy gateway with OpenAI-compatible and
Anthropic-compatible APIs, plus an admin console for credentials, access keys,
usage, debugging, and runtime settings.

> Forked from [Sliverkiss/CodeBuddy2api](https://github.com/Sliverkiss/CodeBuddy2api).

## Quick Start

The following Docker command uses SQLite, recommended for a single instance.
Replace the encryption key with a long random value before production use.

```bash
docker run -d \
  --name codebuddy2api \
  --restart unless-stopped \
  -p 8001:8001 \
  -e CODEBUDDY_STORAGE_BACKEND=sqlite \
  -e CODEBUDDY_STORAGE_ENCRYPTION_KEY='replace-with-a-long-random-secret' \
  -v "$(pwd)/.codebuddy_data:/app/.codebuddy_data" \
  -v "$(pwd)/.codebuddy_creds:/app/.codebuddy_creds" \
  ghcr.io/orangeboychen/codebuddy2api:latest
```

Open `http://127.0.0.1:8001/dashboard`, add a CodeBuddy credential, then create
an access key for API clients. Use PostgreSQL instead of SQLite for multiple
application instances.

## Documentation

- [中文文档](https://orangeboychen.github.io/codebuddy2api/)
- [English documentation](https://orangeboychen.github.io/codebuddy2api/en/)
- [日本語ドキュメント](https://orangeboychen.github.io/codebuddy2api/ja/)

Run the documentation site locally from the repository root:

```bash
bun install
bun install --cwd docs
bun run docs:dev
```

Use `bun run docs:build` to build the static site and `bun run docs:preview` to
preview it.

## Development

```bash
bun install
bun run lint
bun run format:check
bun run typecheck
bun run test:coverage
bunx next build --webpack
```

## License

See [LICENSE](./LICENSE).
