# Settings

Settings controls service parameters, credential models, usage data, and console security.

## Service settings

| Field                                     | Purpose                                                           |
| ----------------------------------------- | ----------------------------------------------------------------- |
| CodeBuddy API endpoint                    | Upstream URL; default `https://copilot.tencent.com`               |
| Admin passkey RP ID / domain              | WebAuthn hostname only; do not include scheme or port             |
| Authentication mode (auto/token)          | Upstream authentication method                                    |
| Network environment (internal/ioa/public) | Upstream network environment                                      |
| Log level                                 | Choose `DEBUG`, `INFO`, `WARNING`, or `ERROR`                     |
| API timeout, first token (minutes)        | Abort a request that produces no first delta in time; default `5` |

Click **Save** after changing a field.

The API timeout is measured from the moment a request is sent until the upstream
produces its first delta, so it bounds the wait for a response that never
starts. Once output has begun, a long answer is allowed to finish however long
it takes. Fractional minutes are accepted, clamped to `0.1`–`1440`. Set the
equivalent `CODEBUDDY_API_TIMEOUT_MINUTES` environment variable to seed the
value before the console is ever opened.

## Models and usage

- **Credential models** lists models for each credential; edit the list or click **Refresh**.
- **Usage event cache** can be permanently cleared with **Clear usage event cache**.

## Console security

Set the administrator username, password, and confirmation password under **Console security**, then click **Save**. Disabling authentication makes the console directly accessible.
