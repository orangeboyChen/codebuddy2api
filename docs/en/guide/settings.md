# Settings

Settings controls runtime behavior and console security without rebuilding the container.

## Service settings

- **CodeBuddy API endpoint**: upstream URL; defaults to `https://copilot.tencent.com`.
- **Authentication mode**: automatic or token-based upstream authentication.
- **Network environment**: internal, IOA, or public routing.
- **Log level**: server logging verbosity.
- **Admin passkey RP ID**: hostname used by WebAuthn passkeys.

Click **Save** after changing service settings. **Credential models** lists discovered models and refreshes them per credential. **Usage event cache** permanently clears usage data. **Console security** sets the administrator username and password; once enabled, unauthenticated users are sent to Login. The passkey RP ID must be a hostname only and must match the browser-visible origin.
