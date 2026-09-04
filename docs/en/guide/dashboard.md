# Dashboard

Dashboard is the first page to check after deployment.

## What it shows

- **Credential totals**: total and currently valid CodeBuddy accounts.
- **API endpoint**: the `/v1` base URL used by clients.
- **Calls today**: request count, total tokens, and cache-hit tokens.

## Typical workflow

1. Open `/dashboard` and confirm the service is reachable.
2. If the active credential count is zero, open **Credentials** and authorize an account.
3. Copy the API endpoint and create an API key under **Credentials**.
4. Configure your client with the endpoint and API key.

Dashboard is a read-only overview; use the other console tabs to make changes.
