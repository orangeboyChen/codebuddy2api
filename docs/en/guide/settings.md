# Settings

Settings controls runtime behavior without rebuilding the container.

Common fields include:

- **CodeBuddy API endpoint**: upstream service URL.
- **Authentication mode**: automatic or token-based upstream authentication.
- **Network environment**: internal, IOA, or public routing.
- **Log level**: server logging verbosity.
- **Admin passkey RP ID**: hostname used by WebAuthn passkeys.

Change one setting at a time, save it, and verify the result in **Dashboard**, **API Test**, or **Debug**. The passkey RP ID must be a hostname only and must match the browser-visible origin.
