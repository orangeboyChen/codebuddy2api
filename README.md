# CodeBuddy2API

Wrap CodeBuddy APIs with an OpenAI-compatible proxy so any standard OpenAI client can talk to CodeBuddy through a unified interface.

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

The OpenAI-compatible API is available at `/v1`:

```
http://<your-host>:8001/v1
```

Both **Chat Completions** (`POST /v1/chat/completions`) and **Responses** (`POST /v1/responses`) endpoints are supported, so you can use it directly with Codex, the OpenAI SDK, or any OpenAI-compatible client.

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
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-5.1",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### Responses API

```bash
curl -X POST "http://127.0.0.1:8001/v1/responses" \
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

### Password Protection

If `CODEBUDDY_PASSWORD` is set, include it as a Bearer token:

```
Authorization: Bearer <password>
```

## Configuration

Settings resolve in this order: `config/config.json` > environment variables > built-in defaults.

| Key                        | Default | Description                                           |
| -------------------------- | ------- | ----------------------------------------------------- |
| `CODEBUDDY_PASSWORD`       | empty   | Optional Bearer password for protected API routes.    |
| `CODEBUDDY_AUTH_MODE`      | `auto`  | `auto`, `api_key`, or `token`.                        |
| `CODEBUDDY_API_KEY`        | empty   | Required when `CODEBUDDY_AUTH_MODE=api_key`.          |
| `CODEBUDDY_ROTATION_COUNT` | `1`     | Rotate credentials every N requests. `0` disables it. |
| `CODEBUDDY_LOG_LEVEL`      | `INFO`  | Runtime log level.                                    |

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
