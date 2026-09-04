# Settings

Settings controls service parameters, credential models, usage data, and console security.

## Service settings

| Field                                     | Purpose                                               |
| ----------------------------------------- | ----------------------------------------------------- |
| CodeBuddy API endpoint                    | Upstream URL; default `https://copilot.tencent.com`   |
| Admin passkey RP ID / domain              | WebAuthn hostname only; do not include scheme or port |
| Authentication mode (auto/token)          | Upstream authentication method                        |
| Network environment (internal/ioa/public) | Upstream network environment                          |
| Log level                                 | Choose `DEBUG`, `INFO`, `WARNING`, or `ERROR`         |

Click **Save** after changing a field.

## Models and usage

- **Credential models** lists models for each credential; edit the list or click **Refresh**.
- **Usage event cache** can be permanently cleared with **Clear usage event cache**.

## Console security

Set the administrator username, password, and confirmation password under **Console security**, then click **Save**. Disabling authentication makes the console directly accessible.
