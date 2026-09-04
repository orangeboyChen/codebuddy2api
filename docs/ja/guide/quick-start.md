# クイックスタート

## SQLite を使った Docker 起動

```bash
docker run -d --name codebuddy2api --restart unless-stopped -p 8001:8001 \
  -e CODEBUDDY_STORAGE_BACKEND=sqlite \
  -e CODEBUDDY_STORAGE_ENCRYPTION_KEY='replace-with-a-long-random-secret' \
  -e CODEBUDDY_STORAGE_IMPORT_LEGACY_FILES=false \
  ghcr.io/orangeboyChen/codebuddy2api:latest
```

`http://127.0.0.1:8001/dashboard` を開きます。単一インスタンスには SQLite、複数インスタンスには PostgreSQL を推奨します。

## 初回利用の手順

1. 「認証情報」で CodeBuddy アカウントを認証します。
2. 「アカウント状態」でクォータとモデルを確認します。
3. 「認証情報」で API key を作成します。
4. 「API テスト」でテストメッセージを送信します。
5. `/v1` endpoint と API key をクライアントに設定します。
