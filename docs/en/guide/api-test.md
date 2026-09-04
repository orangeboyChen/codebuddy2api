# API Test

API Test sends a chat completion directly from the admin console.

1. Select a non-expired credential.
2. Select one of its discovered models.
3. Enter a message.
4. Turn **Stream response** on or off.
5. Click **Send test** and read the **Response** panel.

The page also includes curl and Python examples. External clients call `/v1/chat/completions`, `/v1/responses`, or `/v1/messages` with a managed API key.
