# Debug

Debug records sanitized proxy activity for troubleshooting.

## Capture a problem

1. Enable debug logging and choose a retention limit.
2. Reproduce the failing request once.
3. Return to **Debug** and open the newest entry.
4. Compare the request method, model, status, duration, and error summary.

Tokens, cookies, API keys, authorization headers, and user identifiers are redacted. Debug logs are diagnostic data, not a replacement for application metrics.
