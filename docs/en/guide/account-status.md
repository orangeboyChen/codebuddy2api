# Account Status

Account Status checks quota, check-in state, and available models for each CodeBuddy account.

1. Click **Refresh all**, or click **Refresh** on one account.
2. Review the plan, used / total quota, remaining percentage, and **Reset time**.
3. Check the check-in state; click **Check in** or **Check in all** when available.
4. Expand **Models (N)** before choosing a model in API Test or a client.

Each model shows what the upstream catalog advertises: its display name and
model ID (click to copy), the credit multiplier (for example `x3.33`), its
description, and **Enterprise / Internal / Free / Default** badges — a running
promotion adds a badge of its own, such as a limited-time offer, and a
discounted multiplier (`x3.33 → x0.00`). Below those come the context length,
output ceiling, image / tool / reasoning support and **Thinking only**, and
below that the rest of what upstream declares: vendor, per-request ceiling, the
context lengths on offer, default and selectable thinking efforts, variant IDs,
capability tags, and a promotion's copy and end date. A field upstream does not
declare is left off the card; capability tags, selectable context lengths,
thinking efforts and variants are each kept to the first eight, and a promotion
stops being shown once its window has passed. The first eight models are shown; click **Show all
(N)** for the full list, after which the button reads **Collapse**. An account
with eight models or fewer has no toggle at all.

The description is the one matching the console locale: upstream ships Chinese
and English, so the Japanese console falls back to the English text.

The catalog comes from upstream `/v3/config` and is cached with the credential
after the first query, so later page loads do not call upstream again. Editing
the model list by hand in **Credentials** also drops the metadata of models
that edit removes.

## Automatic check-in

Each account has an **Automatic check-in** switch under its check-in row, off by
default. Turn it on, pick a time, and the gateway checks that account in once a
day at that time.

The time is the server's local time, which is what the rest of the app uses and
can be set with the `TZ` environment variable. The scheduler runs inside the
gateway process, so it only fires while the gateway is running — a deployment
that stops between requests simply checks in on the next pass instead. An
account already checked in is skipped, and only a successful check-in is
recorded, so a failed attempt is retried rather than waiting until tomorrow.

If quota is unknown or the query fails, verify the credential in **Credentials**, then inspect **Debug**.
