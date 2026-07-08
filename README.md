# CodeBuddy2API

Wrap CodeBuddy APIs with an OpenAI-compatible proxy so any standard OpenAI client can talk to CodeBuddy through a unified interface.

This repository is based on the upstream project [Sliverkiss/CodeBuddy2api](https://github.com/Sliverkiss/CodeBuddy2api).

## Features

- **OpenAI-compatible API**: Exposes standard `/v1/*` endpoints and works with the `openai` SDK plus many third-party clients.
- **Dual API support**: Supports both `Chat Completions` (`/v1/chat/completions`) and `Responses` (`/v1/responses`, OpenAI Responses API).
- **Smart response handling**: Even if the upstream CodeBuddy API only supports streaming, this service can aggregate the stream on the backend for non-streaming requests.
- **Web-based authentication**: Supports obtaining a Bearer Token through an OAuth flow, with one-click authorization from the Web admin UI and no need to manually copy tokens.
- **Automatic credential rotation**: Supports multiple credentials in the `.codebuddy_creds` directory, rotates them automatically based on `CODEBUDDY_ROTATION_COUNT`, and also allows manual selection or disabling rotation in the Web UI.
- **Web admin UI**: Built-in admin panel for credential management, API testing, service status, and hot-reloadable settings.
- **High performance**: Built with FastAPI + asyncio + Hypercorn for high-concurrency asynchronous requests.

## Quick Start

The default configuration already includes sensible values. In most cases, you only need to complete one web login flow after startup.

### 1. Prerequisites

- Python 3.8 or later
- Git
- Access to the official CodeBuddy API endpoint

### 2. Clone and Install

```bash
git clone https://github.com/orangeboyChen/CodeBuddy2api.git
cd CodeBuddy2api
```

Create a virtual environment and install dependencies:

```bash
python3 -m venv venv
source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

### 3. Start the Service

```bash
# Make sure the virtual environment is activated
python web.py
```

On Windows, you can also run `start.bat` directly. By default, the service listens on `http://127.0.0.1:8001`.

> The default configuration already includes the endpoint, authentication mode, and credential directory. Most setups work out of the box without changing environment variables.

### 4. Obtain Credentials Through Web Login

This service can obtain a CodeBuddy Bearer Token through an OAuth flow. The recommended way is to complete it from the Web admin UI:

1. Start the service, then open `http://127.0.0.1:8001` in your browser.
2. The admin panel opens immediately and is ready to use.
3. Go to the **Credential Management** tab.
4. In the **Automatic Authentication** card, click **Start Authentication**.
5. The service calls CodeBuddy's `/v2/plugin/auth/state` endpoint to generate a login URL (`authUrl`). Click **Open Link**.
6. Complete the authorization flow on the login page that opens.
7. After login succeeds, close the login page. The service automatically polls `/v2/plugin/auth/token`, detects the login result, then retrieves, parses, and saves the new Bearer Token credential. Click **Refresh List** to see the newly added credential.

> The default polling interval is 5 seconds. The auth state remains valid for 1800 seconds (30 minutes). Credential files are stored as JSON under `.codebuddy_creds/`. Once this step is complete, you can start calling the API.

## API Usage

### Client Integration Examples

Any client that supports the OpenAI API can be pointed at this service. The examples below use the default model `glm-5.1`.

**Python (`openai` SDK):**

```python
import openai

client = openai.OpenAI(
    api_key="any",
    base_url="http://127.0.0.1:8001/v1"
)

# Non-streaming
response = client.chat.completions.create(
    model="glm-5.1",
    messages=[{"role": "user", "content": "Hello, what is 2+2?"}]
)
print(response.choices[0].message.content)

# Streaming
stream = client.chat.completions.create(
    model="glm-5.1",
    messages=[{"role": "user", "content": "Write a Python Hello World script"}],
    stream=True
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")
```

**`curl` example:**

```bash
curl -X POST "http://127.0.0.1:8001/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-5.1",
    "messages": [{"role": "user", "content": "What model are you?"}],
    "stream": false
  }'
```

**Responses API:**

```bash
curl -X POST "http://127.0.0.1:8001/v1/responses" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.5",
    "input": "Write a Python Hello World script",
    "stream": false
  }'
```

```python
import openai

client = openai.OpenAI(
    api_key="any",
    base_url="http://127.0.0.1:8001/v1"
)

resp = client.responses.create(
    model="gpt-5.5",
    input="Hello, what is 2+2?"
)
print(resp.output_text)
```

> Notes:
> - When `stream=true`, the upstream SSE event stream is passed through directly (`response.created`, `response.output_text.delta`, `response.completed`, and so on).
> - When `stream=false`, the backend still sends a streaming request upstream and aggregates the result into a single Response object before returning it.

## API Endpoints

To stay compatible with standard OpenAI clients, all of the following endpoints use the `/v1/*` path prefix:

- `POST /v1/chat/completions`: Chat Completions endpoint.
- `POST /v1/responses`: Responses endpoint (OpenAI Responses API).
- `GET /v1/models`: Returns the list of currently available models.
- `GET /v1/credentials`: (Auth required) List all credentials.
- `POST /v1/credentials`: (Auth required) Add a new credential.
- `POST /v1/credentials/select`: (Auth required) Manually select which credential to use.
- `POST /v1/credentials/auto`: (Auth required) Re-enable automatic rotation.
- `POST /v1/credentials/toggle-rotation`: (Auth required) Toggle automatic credential rotation.
- `GET /v1/credentials/current`: (Auth required) Get information about the currently active credential.
- `POST /v1/credentials/delete`: (Auth required) Delete a credential by index.
- `GET /codebuddy/auth/start`: Start the web authentication flow.
- `POST /codebuddy/auth/poll`: Poll authentication status and obtain the token.
- `GET /codebuddy/auth/callback`: OAuth2 callback endpoint.
- `GET /health`: Health check endpoint.
- `GET /api/settings` / `POST /api/settings`: Read and save service settings with hot reload.

## Project Structure

```text
CodeBuddy2api/
├── src/                           # Source code
│   ├── auth.py                    # Service access authentication
│   ├── codebuddy_api_client.py    # Wrapper for CodeBuddy official API communication
│   ├── codebuddy_auth_router.py   # OAuth2 authentication routes
│   ├── codebuddy_token_manager.py # Credential loading and rotation manager
│   ├── codebuddy_router.py        # Core API routes (v1)
│   ├── frontend_router.py         # Web admin UI routes
│   ├── settings_router.py         # Settings management routes (hot reload)
│   ├── usage_stats_manager.py     # Usage statistics manager
│   └── keyword_replacer.py        # Keyword replacement module
├── frontend/
│   └── admin.html                 # Web admin UI frontend
├── config/                        # Persistent configuration directory (config/config.json)
├── .codebuddy_creds/              # Directory for CodeBuddy credentials (contents ignored by Git)
├── web.py                         # FastAPI service entry point
├── config.py                      # Multi-layer configuration management (hot reload)
├── requirements.txt               # Python dependencies
├── docker-compose.yml             # Docker Compose configuration
├── Dockerfile                     # Docker image build file
├── entrypoint.sh                  # Docker container entrypoint
├── start.bat                      # Windows startup script
└── README.md                      # This document
```

## Configuration

All settings can be adjusted through environment variables or from the **Settings** page in the Web admin UI. Changes take effect immediately and are persisted to `config/config.json`.

Configuration priority, from highest to lowest:
Web UI in-memory hot updates > `config/config.json` > environment variables / `.env` > built-in defaults

| Environment Variable | Default | Description |
| --- | --- | --- |
| `CODEBUDDY_HOST` | `127.0.0.1` | Host address the service listens on. For Docker deployments, set it to `0.0.0.0`. |
| `CODEBUDDY_PORT` | `8001` | Service listening port. |
| `CODEBUDDY_API_ENDPOINT` | `https://copilot.tencent.com` | Official CodeBuddy endpoint. |
| `CODEBUDDY_AUTH_MODE` | `auto` | Authentication mode: `auto` prefers API Key, otherwise it uses a saved token credential. |
| `CODEBUDDY_API_KEY` | empty | Used for direct API Key mode. Leave empty when using web login. |
| `CODEBUDDY_CREDS_DIR` | `.codebuddy_creds` | Directory where credential JSON files are stored. |
| `CODEBUDDY_LOG_LEVEL` | `INFO` | Log level: `DEBUG` / `INFO` / `WARNING` / `ERROR`. |
| `CODEBUDDY_MODELS` | built-in model list | Comma-separated list of models reported to clients. |
| `CODEBUDDY_ROTATION_COUNT` | `1` | Rotate to the next credential every N requests. Set to `0` to disable automatic rotation. |

## Troubleshooting

- **"No valid CodeBuddy credentials found"**: Web authentication has not been completed yet, or there is no valid credential JSON file under `.codebuddy_creds/`. In the Web UI credential management page, click **Start Authentication** and finish the login flow.
- **"API error: 401" / "API error: 403" (from CodeBuddy)**: The Bearer Token is invalid or expired. Log in again to obtain a new credential, or delete the expired credential and re-authenticate.
- **Authentication link cannot be opened / login timed out**: Make sure your environment can reach `https://copilot.tencent.com`. The auth state is valid for 30 minutes; after it expires, click **Start Authentication** again.
- **Need detailed logs**: Change `CODEBUDDY_LOG_LEVEL` to `DEBUG` in the Web UI settings page, or set the environment variable and restart the service.

## License

See [LICENSE](./LICENSE) for details.
