# Dashboard

Dashboard is the first page to check after deployment.

## What it shows

- **Credential totals**: total and currently valid CodeBuddy accounts.
- **API endpoint**: the `/v1` base URL used by clients.
- **Recent usage**: request and token summaries for the selected period.

## Typical workflow

1. Open `/dashboard` and confirm the service is reachable.
2. If the valid credential count is zero, open **Credentials** and authorize an account.
3. Copy the API endpoint shown on the page.
4. Create an access key under **Credentials**, then configure your SDK with the endpoint and key.

Dashboard is a read-only overview; use the other console tabs to make changes.
