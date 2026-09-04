# Docker とストレージの設定

## SQLite（単一インスタンス）

SQLite は単一インスタンス向けの推奨バックエンドです。以下のコマンドは volume なしで起動できます。

```bash
docker run -d --name codebuddy2api --restart unless-stopped -p 8001:8001 \
  -e CODEBUDDY_STORAGE_BACKEND=sqlite \
  -e CODEBUDDY_STORAGE_ENCRYPTION_KEY='replace-with-a-long-random-secret' \
  -e CODEBUDDY_STORAGE_IMPORT_LEGACY_FILES=false \
  ghcr.io/orangeboychen/codebuddy2api:latest
```

データベースの既定パスは `/app/.codebuddy_data/storage.sqlite` です。コンテナの削除や再作成後もデータを残す場合は `-v codebuddy2api-data:/app/.codebuddy_data` を追加します。

起動後に `http://127.0.0.1:8001/dashboard` を開きます。

## PostgreSQL（複数インスタンス）

複数インスタンスでは PostgreSQL を使用します。

```bash
-e CODEBUDDY_STORAGE_BACKEND=pg \
-e DATABASE_URL='postgres://user:password@db:5432/codebuddy2api' \
-e CODEBUDDY_STORAGE_ENCRYPTION_KEY='replace-with-a-long-random-secret'
```

## 旧ファイルからの移行

`.codebuddy_creds` や旧 JSON 設定がある場合、データベースバックエンドの初回起動時は `CODEBUDDY_STORAGE_IMPORT_LEGACY_FILES=false` を設定せず、旧ディレクトリを一時的にマウントします。

```bash
-v "$(pwd)/.codebuddy_creds:/app/.codebuddy_creds"
```

移行完了後に `CODEBUDDY_STORAGE_IMPORT_LEGACY_FILES=false` を設定し、旧ディレクトリのマウントを削除します。

## 環境変数

| 変数                                    | 用途                                               | 例 / 既定値                                      |
| --------------------------------------- | -------------------------------------------------- | ------------------------------------------------ |
| `CODEBUDDY_STORAGE_BACKEND`             | ストレージバックエンド                             | `file`、`sqlite`、`pg`                           |
| `CODEBUDDY_STORAGE_SQLITE_PATH`         | SQLite ファイルパス                                | `.codebuddy_data/storage.sqlite`                 |
| `CODEBUDDY_STORAGE_ENCRYPTION_KEY`      | DB 内の機密データを暗号化。DB バックエンドでは必須 | 長いランダム文字列                               |
| `CODEBUDDY_STORAGE_IMPORT_LEGACY_FILES` | 旧ファイルを取り込むか                             | 新規構築では `false`                             |
| `DATABASE_URL`                          | PostgreSQL 接続文字列                              | `postgres://user:password@db:5432/codebuddy2api` |
| `CODEBUDDY_API_ENDPOINT`                | 上流 CodeBuddy API URL                             | `https://copilot.tencent.com`                    |
| `CODEBUDDY_AUTH_MODE`                   | 上流認証モード                                     | `auto` / `token`                                 |
| `CODEBUDDY_INTERNET_ENVIRONMENT`        | ネットワーク環境                                   | `internal` / `ioa` / `public`                    |
| `CODEBUDDY_LOG_LEVEL`                   | サーバーログレベル                                 | `INFO`                                           |
| `CODEBUDDY_ADMIN_PASSKEY_RP_ID`         | 管理者 Passkey の hostname                         | `example.com`                                    |
