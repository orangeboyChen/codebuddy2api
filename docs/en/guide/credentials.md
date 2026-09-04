# Credentials

Credentials are the CodeBuddy accounts used by the proxy.

## Add an account

1. Open **Credentials**.
2. Start the CodeBuddy OAuth flow or add a credential through the available login action.
3. Complete authorization in the browser.
4. Return to the console and refresh the list.

## Create an API access key

1. Open the access-key section on the Credentials page.
2. Give the key a recognizable name.
3. Copy the secret immediately; it is only shown when created or explicitly revealed.
4. Send it as `Authorization: Bearer <access-key>` or `x-api-key: <access-key>`.

Never put a credential file or access key in the documentation site, source repository, or client-side demo code.
