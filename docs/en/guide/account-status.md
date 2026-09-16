# Account Status

Account Status checks quota, check-in state, and available models for each CodeBuddy account.

1. Click **Refresh all**, or click **Refresh** on one account.
2. Review the plan, used / total quota, remaining percentage, and **Reset time**.
3. Check the check-in state; click **Check in** or **Check in all** when available.
4. Expand **Available models** before choosing a model in API Test or a client.

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
