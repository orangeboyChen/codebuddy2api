# Usage

Usage reports request volume and token consumption.

## Filter the report

1. Choose a **Time range**, such as `24 hours`, `7 days`, or **Today**.
2. Optionally filter by credential or access key.
3. Click **Refresh**, or choose an **Auto-refresh** interval.
4. Read the summary cards for calls, tokens, and cache-hit tokens.

## Investigate a spike

1. Start with the **Call trend** and **Token trend** charts.
2. Select the model or credential with the largest change in the table.
3. Compare the result with **Debug** logs to connect usage to individual requests.

**Clear history** permanently removes stored usage events.

Usage data is stored by the configured storage backend and is retained according to the server settings.
