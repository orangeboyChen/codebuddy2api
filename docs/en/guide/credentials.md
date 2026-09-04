# Credentials

Credentials manages CodeBuddy accounts and the API keys used by clients.

## Add an account

1. Open **Credentials**.
2. Click **Start authentication**, or choose **Add credential manually**.
3. Complete authorization in the browser.
4. Return to the console and refresh the list.

## Create an API access key

1. In the **API key** section, click **Create API key**.
2. Give the key a recognizable name.
3. Copy the secret immediately. Use **Reveal key** later only when necessary.
4. Send it as `Authorization: Bearer <access-key>` or `x-api-key: <access-key>`.

The saved-credentials list shows active state, expiry, domain, and upstream protocol. Use **Edit** to change an entry and **Delete** to remove it. Reauthorize an account after it expires.
