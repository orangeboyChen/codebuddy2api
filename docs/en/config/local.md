# Local Development

Run locally for development and debugging, not as the production deployment method.

```bash
bun install
mkdir -p .codebuddy_data .codebuddy_creds
bun run dev
```

Open `http://127.0.0.1:3000/dashboard`. `.codebuddy_creds` supports legacy file-based authentication; SQLite development can use only `.codebuddy_data`.
