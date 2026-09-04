# Account Status

Account Status is the health check for each CodeBuddy account.

For every account, review the email or user ID, expiration state, and available models.

When a request fails:

1. Check whether the account is expired.
2. Re-authorize it from **Credentials** if necessary.
3. Confirm that the requested model is listed for the account.
4. Open **Debug** for the upstream error details.
