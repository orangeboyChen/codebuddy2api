# Settings

Settings controls service parameters, credential models, usage data, and console security.

## Service settings

| Field                                     | Purpose                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------------------ |
| CodeBuddy API endpoint                    | Upstream URL; default `https://copilot.tencent.com`                                        |
| Admin passkey RP ID / domain              | WebAuthn hostname only; do not include scheme or port                                      |
| Authentication mode (auto/token)          | Upstream authentication method                                                             |
| Network environment (internal/ioa/public) | Upstream network environment                                                               |
| Log level                                 | Choose `DEBUG`, `INFO`, `WARNING`, or `ERROR`                                              |
| API timeout, first token (minutes)        | Abort a request that produces no first delta in time; default `5`                          |
| Translate thought depth for Hy models     | Convert downstream thinking parameters into the upstream `reasoning_effort`; default `off` |

Click **Save** after changing a field.

The API timeout is measured from the moment a request is sent until the upstream
produces its first delta, so it bounds the wait for a response that never
starts. Once output has begun, a long answer is allowed to finish however long
it takes. Fractional minutes are accepted, clamped to `0.1`–`1440`. Set the
equivalent `CODEBUDDY_API_TIMEOUT_MINUTES` environment variable to seed the
value before the console is ever opened.

Hy-series models (`hy3` and friends) accept only three `reasoning_effort` values
— `no_think`, `low` and `high` — and no downstream client speaks that
vocabulary: Claude Code sends Anthropic `thinking`, while Codex sends Responses
`reasoning.effort`. Enabling the setting converts both onto the Hy vocabulary:

| Downstream value                             | Converted to |
| -------------------------------------------- | ------------ |
| `thinking.type: disabled`, `minimal`, `none` | `no_think`   |
| `budget_tokens` ≤ 8K, `low`, `medium`        | `low`        |
| `budget_tokens` > 8K, `high`, `xhigh`, `max` | `high`       |

Any model id starting with `hy` counts as a Hy model, case-insensitively, so
`hy3` and `hy3-ioa` match today and a future `hy4` is covered without a code
change. `hunyuan-*` is a different prefix and a separate product line, so it
<<<<<<< HEAD
does not match.

Once translated, the original `thinking` block is dropped: leaving it alongside
the converted effort would ask for the same thing twice in two vocabularies, and
would still be rejected by the upstream this conversion exists to satisfy. The
setting defaults to off, which forwards requests unchanged. Seed it before the
console is opened with `CODEBUDDY_HY_THOUGHT_DEPTH_ENABLED` (`true` / `false`).
=======
does not match. The default is `off`, which forwards requests unchanged. Seed it
before the console is opened with `CODEBUDDY_HY_THOUGHT_DEPTH` (`on` / `off`,
also `1` / `0`, `true` / `false`).
>>>>>>> a3c3abf (fix(settings): match every hy-prefixed model as a Hy model)

## Models and usage

- **Credential models** lists models for each credential; edit the list or click **Refresh**.
- **Usage event cache** can be permanently cleared with **Clear usage event cache**.

## Console security

Set the administrator username, password, and confirmation password under **Console security**, then click **Save**. Disabling authentication makes the console directly accessible.
