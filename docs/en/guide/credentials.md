# Credentials

Credentials has three areas: automatic authentication, API keys, and saved credentials.

## Automatic authentication

1. Click **Start authentication** under **Automatic authentication**.
2. Click **Open link** and finish signing in to CodeBuddy.
3. Return to the console and wait for the status check, or click **Check authentication status**.
4. If the callback does not complete, choose **Manual callback**, paste the full callback URL, and submit it.

## Add manually

Choose **Add credential manually**, enter a CodeBuddy Bearer Token, optionally enter a user ID, choose **Chat** or **Responses**, and click **Save**.

## API keys

1. Click **Create API key** in the **API key** area.
2. Enter a name and select the active credentials to bind.
3. Copy the secret immediately; click **Reveal key** only when needed.
4. Clients send `Authorization: Bearer <API_KEY>` or `x-api-key: <API_KEY>`.

Use **Refresh**, **Edit**, and **Delete** in the saved-credentials list. Reauthenticate an expired credential.
