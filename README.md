# CodeBuddy2API

Wrap CodeBuddy APIs with a proxy that supports both OpenAI-compatible and Anthropic-compatible request formats, so standard OpenAI and Claude clients can talk to CodeBuddy through one unified interface.

> Forked from [Sliverkiss/CodeBuddy2api](https://github.com/Sliverkiss/CodeBuddy2api).

## Quick Start

```bash
docker run -d \
  --name codebuddy2api \
  --restart unless-stopped \
  -p 8001:8001 \
  -v "$(pwd)/config:/app/config" \
  -v "$(pwd)/.codebuddy_creds:/app/.codebuddy_creds" \
  ghcr.io/orangeboychen/codebuddy2api:latest
```

Once running, open `http://127.0.0.1:8001/` in your browser.

## Admin Console

The built-in console is available at the root path:

```
http://<your-host>:8001/
```

From here you can:

- Log in to CodeBuddy via the OAuth flow and save credentials.
- Switch between saved credentials.
- View usage stats and service health.
- Adjust runtime settings.

## Using the API

The proxy supports both OpenAI-style and Anthropic-style inference requests:

```
http://<your-host>:8001/v1
```

Supported endpoints include:

- **Chat Completions**: `POST /v1/chat/completions`
- **Responses**: `POST /v1/responses`
- **Anthropic Messages**: `POST /v1/messages`

This means you can use the proxy directly with Codex, the OpenAI SDK, Claude Code, Anthropic SDK clients, or other OpenAI/Anthropic-compatible tooling.

### Codex

Point Codex at the proxy by setting the base URL and API key:

```bash
export OPENAI_BASE_URL=http://127.0.0.1:8001/v1
export OPENAI_API_KEY=any
codex
```

### Chat Completions

```bash
curl -X POST "http://127.0.0.1:8001/v1/chat/completions" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-5.1",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### Responses API

```bash
curl -X POST "http://127.0.0.1:8001/v1/responses" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-5.1",
    "input": "Hello!"
  }'
```

### Anthropic Messages API (Claude Code)

The Anthropic-compatible Messages API is available at `/v1/messages`, so you can use the proxy directly with **Claude Code** or any Anthropic SDK client. Tools, streaming, extended thinking, and MCP tool calls are all supported. Token usage (including cache creation/read tokens) is returned just like the chat completions API.

```bash
curl -X POST "http://127.0.0.1:8001/v1/messages" \
  -H "Content-Type: application/json" \
  -H "x-api-key: any" \
  -d '{
    "model": "claude-sonnet-4.6",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

#### Claude Code

Point Claude Code at the proxy by setting the API base URL:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8001
export ANTHROPIC_API_KEY=any
claude
```

### OpenAI SDK (TypeScript)

```ts
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: 'any',
  baseURL: 'http://127.0.0.1:8001/v1',
});

const response = await client.chat.completions.create({
  model: 'glm-5.1',
  messages: [{ role: 'user', content: 'Hello!' }],
});

console.log(response.choices[0]?.message?.content);
```

### Authentication

- Client inference routes (`/v1/chat/completions`, `/v1/responses`, `/v1/messages`, `/v1/models`) accept managed access keys. Send them as `Authorization: Bearer <access-key>` or `x-api-key: <access-key>`.
- Global credential management routes under `/v1/credentials*` and `/api/settings` use the same managed access keys.
- The built-in web admin console continues to use its existing `/admin-api/*` routes without introducing a password prompt.

## Configuration

Settings resolve in this order: `config/config.json` > environment variables > built-in defaults.

| Key                   | Default | Description                                         |
| --------------------- | ------- | --------------------------------------------------- |
| `CODEBUDDY_AUTH_MODE` | `auto`  | `auto` or `token`, both based on saved credentials. |
| `CODEBUDDY_LOG_LEVEL` | `INFO`  | Runtime log level.                                  |

See `.env.example` and `config/config.example.json` for all options.

## Deployment

### Docker Compose

```bash
cp .env.example .env
mkdir -p config .codebuddy_creds
docker compose -f deploy/docker-compose.yml up -d
```

### Kubernetes

```bash
kubectl apply -f deploy/k8s/codebuddy2api.yaml
kubectl port-forward service/codebuddy2api 8001:8001
```

## License

See [LICENSE](./LICENSE) for details.
