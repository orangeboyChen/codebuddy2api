# Debug

Debug records sanitized proxy activity for troubleshooting.

## Capture a problem

1. Choose an **Auto-refresh interval**, or leave it **Off** for manual refresh.
2. Enable **Enable debug capture**.
3. Set **Max retained records** and click **Save**.
4. Reproduce the failing request once.
5. Use the interface type, model, credential, and API key filters.
6. Expand the newest record to inspect route, statuses, token counts, TPS, duration, and payload details.

**Clear** permanently removes retained records. Tokens, cookies, API keys, authorization headers, and user identifiers are redacted.
