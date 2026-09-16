# Settings

Settings controls service parameters, credential models, usage data, and console security.

## Service settings

| Field                                     | Purpose                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------- |
| CodeBuddy API endpoint                    | Upstream URL; default `https://copilot.tencent.com`                                         |
| Admin passkey RP ID / domain              | WebAuthn hostname only; do not include scheme or port                                       |
| Authentication mode (auto/token)          | Upstream authentication method                                                              |
| Network environment (internal/ioa/public) | Upstream network environment                                                                |
| Log level                                 | Choose `DEBUG`, `INFO`, `WARNING`, or `ERROR`                                               |
| API timeout, first token (minutes)        | Abort a request that produces no first delta in time; default `5`                           |
| Web search backend                        | Who runs `web_search`: `codebuddy`, `searxng`, or `passthrough`. Default `searxng`          |
| Web fetch backend                         | Who runs `web_fetch`: `codebuddy`, `codebuddy2api`, or `passthrough`. Default `passthrough` |
| Translate thought depth for Hy models     | Convert downstream thinking parameters into the upstream `reasoning_effort`; default `off`  |

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
does not match.

Once translated, the original `thinking` block is dropped: leaving it alongside
the converted effort would ask for the same thing twice in two vocabularies, and
would still be rejected by the upstream this conversion exists to satisfy. The
setting defaults to off, which forwards requests unchanged. Seed it before the
console is opened with `CODEBUDDY_HY_THOUGHT_DEPTH_ENABLED` (`true` / `false`).

## Server tools

Anthropic clients declare search and fetch as server-side tools
(`web_search_20260209`, `web_fetch_20250910`) and Codex declares
`web_search_preview`. CodeBuddy has no equivalent, so when a client declares one
the proxy swaps it for a plain function tool, runs it itself, and appends the
result as a tool message. The model answers normally and the client never learns
the work happened locally.

Each tool has its own backend, chosen independently:

| Tool         | Backend         | What it does                                                            |
| ------------ | --------------- | ----------------------------------------------------------------------- |
| `web_search` | `codebuddy`     | Calls CodeBuddy's own `/agenttool/v1/search` with a saved credential.   |
| `web_search` | `searxng`       | Queries a SearXNG instance. Default. Requires `SEARXNG_URL`.            |
| `web_fetch`  | `codebuddy`     | Calls CodeBuddy's own `/agenttool/v1/webfetch`. Returns extracted text. |
| `web_fetch`  | `codebuddy2api` | This server fetches the page directly and converts HTML to text.        |
| either       | `none`          | Never run the tool; drop it from the request.                           |

`codebuddy` is the reason to reach for this setting: it is the same endpoint the
CodeBuddy CLI calls, so it needs no extra deployment and authenticates with the
credential already saved in the gateway. `searxng` stays the default so existing
deployments are unaffected, and the console hides the search setting entirely
when `SEARXNG_URL` is unset — a deployment cannot advertise a tool it cannot
execute.

The `codebuddy2api` fetch backend treats the URL as untrusted input, since it comes from
the model: private and loopback addresses are refused before connecting, and
redirects are re-checked at every hop so a public URL cannot redirect onto the
deployment's own network.

There is no separate enable switch: `passthrough` hands the tool to the client,
so the backend choice cannot contradict itself. Both default to `none`. Seed them before opening the
console with `CODEBUDDY_WEB_SEARCH_BACKEND` and `CODEBUDDY_WEB_FETCH_BACKEND`.

## Models and usage

- **Credential models** lists models for each credential; edit the list or click **Refresh**.
- **Usage event cache** can be permanently cleared with **Clear usage event cache**.

## Console security

Set the administrator username, password, and confirmation password under **Console security**, then click **Save**. Disabling authentication makes the console directly accessible.
