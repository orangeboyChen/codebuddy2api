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
| Web search backend                        | Which engine runs `web_search`; one choice. See below.                                     |
| Web fetch backend                         | Which backends fetch a page; several choices, tried in order. See below.                   |
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
does not match.

Once translated, the original `thinking` block is dropped: leaving it alongside
the converted effort would ask for the same thing twice in two vocabularies, and
would still be rejected by the upstream this conversion exists to satisfy. The
setting defaults to off, which forwards requests unchanged. Seed it before the
console is opened with `CODEBUDDY_HY_THOUGHT_DEPTH_ENABLED` (`true` / `false`).

### Thinking effort per model

Separately from the setting above, a request that names a thinking level is
checked against the efforts the upstream catalog says the model accepts. Both
`/v1/messages` and `/v1/responses` read whatever vocabulary the client used —
Anthropic `thinking`, `reasoning_effort` or `reasoning.effort` — onto one ladder
and send the nearest level the model advertises, in the model's own spelling. A
model upstream describes as unable to reason receives no thinking field at all,
and one the catalog does not describe is forwarded unchanged.

## Server tools

Anthropic clients declare search and fetch as server-side tools
(`web_search_20260209`, `web_fetch_20250910`) and Codex declares
`web_search_preview`. CodeBuddy has no equivalent, so when a client declares one
the proxy swaps it for a plain function tool, runs it itself, and appends the
result as a tool message. The model answers normally and the client never learns
the work happened locally.

### Web search backend

One engine runs every `web_search`. Every engine is offered whether or not it is
configured, and selecting one reveals the fields it needs:

| Backend      | Configuration                         | Notes                                                             |
| ------------ | ------------------------------------- | ----------------------------------------------------------------- |
| `codebuddy`  | none                                  | CodeBuddy's own `/agenttool/v1/search`; needs a saved credential. |
| `searxng`    | instance address (with port), API key | Your own instance. Default. Key is optional.                      |
| `duckduckgo` | region                                | No credential at all; returns curated instant answers.            |
| `brave`      | API key                               | Brave Search, an independent index.                               |
| `tavily`     | API key                               | Returns page text, not just snippets.                             |
| `serper`     | API key                               | Google results through Serper.                                    |
| `bing`       | API key                               | Bing Web Search.                                                  |
| `exa`        | API key                               | Semantic search; matches meaning rather than keywords.            |

An engine that cannot run — a key that was never filled in, or SearXNG with no
address — resolves to no backend, and the tool is then dropped from the request
rather than advertised and left to fail. That is why the default is `searxng`:
a fresh deployment has no address, so nothing is promised until one is entered.
`codebuddy` is the exception: it needs no configuration of its own, so it runs
whenever it is selected and reports a missing credential as a failed search
rather than being withdrawn.

**Off** closes the list. Pick it — or set `CODEBUDDY_WEB_SEARCH_BACKEND=none` —
and the gateway stops running `web_search`; a client that declares the tool has
it dropped from the request. A deployment that saved `none` before this list
existed keeps that meaning after upgrading.

### Web fetch backend

Any number of backends may be selected, and they are tried in the order they
were selected — the first one that answers wins. This is worth doing because the
backends fail in different ways: a direct fetch is refused by some pages, while
a browser agent is far slower than a direct fetch.

| Backend         | Configuration    | Notes                                                                     |
| --------------- | ---------------- | ------------------------------------------------------------------------- |
| `codebuddy`     | none             | CodeBuddy's own `/agenttool/v1/webfetch`, falling back to a direct fetch. |
| `codebuddy2api` | none             | This server fetches the page directly and converts HTML to text. Default. |
| `browserable`   | address, API key | Drives a real browser through a Browserable deployment. Key is optional.  |
| `jina`          | API key          | Jina Reader returns the page as markdown. Key is optional.                |

Selecting none is how the tool is turned off. `web_fetch` runs locally by
default now, so a deployment that had left it set to `passthrough` starts
fetching pages itself on upgrade — clear the selection to go back.

`codebuddy` is the reason to reach for this setting: it is the same endpoint the
CodeBuddy CLI calls, so it needs no extra deployment and authenticates with the
credential already saved in the gateway.

The `codebuddy2api` fetch backend treats the URL as untrusted input, since it comes from
the model: private and loopback addresses are refused before connecting, and
redirects are re-checked at every hop so a public URL cannot redirect onto the
deployment's own network.

Both selections can be seeded before the console is opened with
`CODEBUDDY_WEB_SEARCH_BACKEND` and `CODEBUDDY_WEB_FETCH_BACKEND` (the latter
accepts a comma-separated list), and every backend's own configuration has an
equivalent environment variable — `CODEBUDDY_SEARXNG_URL`,
`CODEBUDDY_BRAVE_API_KEY`, `CODEBUDDY_BROWSERABLE_URL`, and so on. SearXNG also
still honours `SEARXNG_URL` and `SEARXNG_API_KEY` when the console fields are
empty.

## Models and usage

- **Credential models** lists models for each credential; edit the list or click **Refresh**.
- **Usage event cache** can be permanently cleared with **Clear usage event cache**.

## Console security

Set the administrator username, password, and confirmation password under **Console security**, then click **Save**. Disabling authentication makes the console directly accessible.
