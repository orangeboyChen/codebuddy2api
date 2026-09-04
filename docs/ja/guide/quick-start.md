# クイックスタート

## SQLite を使った Docker 起動

```bash
docker run -d --name codebuddy2api --restart unless-stopped -p 8001:8001 \
  -e CODEBUDDY_STORAGE_BACKEND=sqlite \
  -e CODEBUDDY_STORAGE_ENCRYPTION_KEY='replace-with-a-long-random-secret' \
  -v "$(pwd)/.codebuddy_data:/app/.codebuddy_data" \
  -v "$(pwd)/.codebuddy_creds:/app/.codebuddy_creds" \
  ghcr.io/orangeboyChen/codebuddy2api:latest
```

`http://127.0.0.1:8001/dashboard` を開きます。単一インスタンスには SQLite、複数インスタンスには PostgreSQL を推奨します。

## ドキュメントのローカル起動

リポジトリのルートで `bun install`、`bun install --cwd docs`、`bun run docs:dev` を実行します。
