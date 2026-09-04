# Docker 与存储配置

## 推荐配置：SQLite

SQLite 适合单实例部署。所有运行时数据（包括凭据、访问密钥、管理员状态、用量和调试日志）都保存在数据库文件中，因此只需要挂载 `.codebuddy_data`：

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

- `CODEBUDDY_STORAGE_BACKEND=sqlite`：启用 SQLite。
- `CODEBUDDY_STORAGE_SQLITE_PATH`：数据库路径；默认就是 `.codebuddy_data/storage.sqlite`。
- `CODEBUDDY_STORAGE_ENCRYPTION_KEY`：数据库后端必填，用于加密敏感数据。请妥善保存，丢失后无法解密旧数据。
- `CODEBUDDY_STORAGE_IMPORT_LEGACY_FILES=false`：新部署不从旧 JSON 文件导入。
- `.codebuddy_data`：唯一需要持久化挂载的目录。

启动后打开 `http://127.0.0.1:8001/dashboard`。

## 旧文件存储迁移

如果已有 `.codebuddy_creds` 或旧 JSON 配置，第一次启动 SQLite 时暂时不要设置 `CODEBUDDY_STORAGE_IMPORT_LEGACY_FILES=false`，并同时挂载两个目录：

```bash
-v "$(pwd)/.codebuddy_data:/app/.codebuddy_data" \
-v "$(pwd)/.codebuddy_creds:/app/.codebuddy_creds" \
```

确认迁移完成后，再改为 `false` 并移除 `.codebuddy_creds` 挂载。

## PostgreSQL

多实例部署使用 PostgreSQL：

```bash
-e CODEBUDDY_STORAGE_BACKEND=pg \
-e DATABASE_URL='postgres://user:password@db:5432/codebuddy2api' \
-e CODEBUDDY_STORAGE_ENCRYPTION_KEY='replace-with-a-long-random-secret'
```

PostgreSQL 不需要挂载 `.codebuddy_creds`；只在迁移旧文件时临时挂载。

## 常用运行时配置

- `CODEBUDDY_API_ENDPOINT`：上游 CodeBuddy API 地址。
- `CODEBUDDY_AUTH_MODE`：上游认证模式，`auto` 或 `token`。
- `CODEBUDDY_INTERNET_ENVIRONMENT`：`internal`、`ioa` 或 `public`。
- `CODEBUDDY_LOG_LEVEL`：日志级别。
- `CODEBUDDY_ADMIN_PASSKEY_RP_ID`：管理员 Passkey 使用的域名。
