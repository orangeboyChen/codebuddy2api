# Docker とストレージの設定

## 推奨：SQLite

SQLite は単一インスタンス向けです。認証情報、アクセスキー、管理者状態、利用量、デバッグログを含む実行データはデータベースに保存されるため、新規構築では `.codebuddy_data` だけをマウントします。

```bash
docker run -d \
  --name codebuddy2api \
  --restart unless-stopped \
  -p 8001:8001 \
  -e CODEBUDDY_STORAGE_BACKEND=sqlite \
  -e CODEBUDDY_STORAGE_SQLITE_PATH=.codebuddy_data/storage.sqlite \
  -e CODEBUDDY_STORAGE_ENCRYPTION_KEY='replace-with-a-long-random-secret' \
  -e CODEBUDDY_STORAGE_IMPORT_LEGACY_FILES=false \
  -v "$(pwd)/.codebuddy_data:/app/.codebuddy_data" \
  ghcr.io/orangeboyChen/codebuddy2api:latest
```

- `CODEBUDDY_STORAGE_BACKEND=sqlite` で SQLite を有効にします。
- `CODEBUDDY_STORAGE_SQLITE_PATH` の既定値は `.codebuddy_data/storage.sqlite` です。
- `CODEBUDDY_STORAGE_ENCRYPTION_KEY` は必須です。紛失すると暗号化データを復号できません。
- `CODEBUDDY_STORAGE_IMPORT_LEGACY_FILES=false` は新規構築で旧 JSON の取り込みを無効にします。
- 新規 SQLite 構築で永続化が必要なディレクトリは `.codebuddy_data` だけです。

起動後に `http://127.0.0.1:8001/dashboard` を開きます。

## 旧ファイルからの移行

既存の `.codebuddy_creds` や JSON 設定を移行する場合、SQLite の初回起動時は `CODEBUDDY_STORAGE_IMPORT_LEGACY_FILES=false` を設定せず、両方のディレクトリをマウントします。移行完了後に `false` を設定し、`.codebuddy_creds` のマウントを削除します。

## PostgreSQL

複数インスタンスでは PostgreSQL を使用します。

```bash
-e CODEBUDDY_STORAGE_BACKEND=pg \
-e DATABASE_URL='postgres://user:password@db:5432/codebuddy2api' \
-e CODEBUDDY_STORAGE_ENCRYPTION_KEY='replace-with-a-long-random-secret'
```

旧ファイルの移行時を除き、PostgreSQL に `.codebuddy_creds` は必要ありません。
