# ローカル開発

ローカル起動は開発とデバッグ用です。本番デプロイには Docker を使用してください。

```bash
bun install
mkdir -p .codebuddy_data .codebuddy_creds
bun run dev
```

`http://127.0.0.1:3000/dashboard` を開きます。`.codebuddy_creds` は旧ファイル認証との互換用で、SQLite の開発では `.codebuddy_data` だけでも実行できます。
