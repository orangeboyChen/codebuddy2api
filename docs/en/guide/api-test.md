# API Test

API Test sends a request from the admin console without configuring an external SDK.

1. Select a non-expired credential.
2. Select one of its discovered models.
3. Enter a message.
4. Turn streaming on or off.
5. Click **Send** and inspect the response panel.

Use this page to verify credentials and model access before troubleshooting a client integration. External clients should call `/v1/chat/completions`, `/v1/responses`, or `/v1/messages` with a managed access key.
