# Docker とストレージの設定

## 推奨：SQLite

SQLite は単一インスタンス向けです。実行に Docker volume は必須ではありません。コンテナの削除や再作成後もデータを残す場合は `/app/.codebuddy_data` をマウントします。

```bash
docker run -d \
  --name codebuddy2api \
  --restart unless-stopped \
  -p 8001:8001 \
  -e CODEBUDDY_STORAGE_BACKEND=sqlite \
  -e CODEBUDDY_STORAGE_SQLITE_PATH=.codebuddy_data/storage.sqlite \
  -e CODEBUDDY_STORAGE_ENCRYPTION_KEY='replace-with-a-long-random-secret' \
  -e CODEBUDDY_STORAGE_IMPORT_LEGACY_FILES=false \
  ghcr.io/orangeboyChen/codebuddy2api:latest
```

- `CODEBUDDY_STORAGE_BACKEND=sqlite` で SQLite を有効にします。
- `CODEBUDDY_STORAGE_SQLITE_PATH` の既定値は `.codebuddy_data/storage.sqlite` です。
- `CODEBUDDY_STORAGE_ENCRYPTION_KEY` は必須です。紛失すると暗号化データを復号できません。
- `CODEBUDDY_STORAGE_IMPORT_LEGACY_FILES=false` は新規構築で旧 JSON の取り込みを無効にします。
- 永続化が必要な場合のみ `-v codebuddy2api-data:/app/.codebuddy_data` を追加します。SQLite データベースはこのディレクトリに保存されます。

起動後に `http://127.0.0.1:8001/dashboard` を開きます。

### SQLite 環境変数

| 変数                                    | 用途                                        | 例 / 既定値                      |
| --------------------------------------- | ------------------------------------------- | -------------------------------- |
| `CODEBUDDY_STORAGE_BACKEND`             | ストレージバックエンド                      | `sqlite`                         |
| `CODEBUDDY_STORAGE_SQLITE_PATH`         | SQLite ファイルパス                         | `.codebuddy_data/storage.sqlite` |
| `CODEBUDDY_STORAGE_ENCRYPTION_KEY`      | 機密データの暗号化。DB バックエンドでは必須 | 長いランダム文字列               |
| `CODEBUDDY_STORAGE_IMPORT_LEGACY_FILES` | 旧ファイルを取り込むか                      | 新規構築では `false`             |

## 旧ファイルからの移行

既存の `.codebuddy_creds` や JSON 設定を移行する場合、SQLite の初回起動時は `CODEBUDDY_STORAGE_IMPORT_LEGACY_FILES=false` を設定せず、旧認証情報ディレクトリを追加でマウントします。移行完了後に `false` を設定し、`.codebuddy_creds` のマウントを削除します。

## PostgreSQL

複数インスタンスでは PostgreSQL を使用します。

```bash
-e CODEBUDDY_STORAGE_BACKEND=pg \
-e DATABASE_URL='postgres://user:password@db:5432/codebuddy2api' \
-e CODEBUDDY_STORAGE_ENCRYPTION_KEY='replace-with-a-long-random-secret'
```

旧ファイルの移行時を除き、PostgreSQL に `.codebuddy_creds` は必要ありません。

## 主なランタイム設定

| 変数                             | 用途                   | 例 / 既定値                   |
| -------------------------------- | ---------------------- | ----------------------------- |
| `CODEBUDDY_API_ENDPOINT`         | 上流 CodeBuddy API URL | `https://copilot.tencent.com` |
| `CODEBUDDY_AUTH_MODE`            | 上流認証モード         | `auto` / `token`              |
| `CODEBUDDY_INTERNET_ENVIRONMENT` | ネットワーク環境       | `internal` / `ioa` / `public` |
| `CODEBUDDY_LOG_LEVEL`            | サーバーログレベル     | `INFO`                        |
| `CODEBUDDY_ADMIN_PASSKEY_RP_ID`  | Passkey の hostname    | `example.com`                 |
