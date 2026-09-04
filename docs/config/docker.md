# Docker 与存储配置

## 推荐配置：SQLite

SQLite 适合单实例部署。运行 SQLite 不要求 Docker volume；如果需要在删除或重建容器后保留数据，再额外挂载 `/app/.codebuddy_data`：

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

- `CODEBUDDY_STORAGE_BACKEND=sqlite`：启用 SQLite。
- `CODEBUDDY_STORAGE_SQLITE_PATH`：数据库路径；默认就是 `.codebuddy_data/storage.sqlite`。
- `CODEBUDDY_STORAGE_ENCRYPTION_KEY`：数据库后端必填，用于加密敏感数据。请妥善保存，丢失后无法解密旧数据。
- `CODEBUDDY_STORAGE_IMPORT_LEGACY_FILES=false`：新部署不从旧 JSON 文件导入。
- 可选持久化：`-v codebuddy2api-data:/app/.codebuddy_data`。SQLite 数据库位于该目录。

启动后打开 `http://127.0.0.1:8001/dashboard`。

### SQLite 环境变量

| 变量                                    | 作用                         | 示例 / 默认值                    |
| --------------------------------------- | ---------------------------- | -------------------------------- |
| `CODEBUDDY_STORAGE_BACKEND`             | 存储后端                     | `sqlite`                         |
| `CODEBUDDY_STORAGE_SQLITE_PATH`         | SQLite 文件路径              | `.codebuddy_data/storage.sqlite` |
| `CODEBUDDY_STORAGE_ENCRYPTION_KEY`      | 加密敏感数据；数据库后端必填 | 长随机字符串                     |
| `CODEBUDDY_STORAGE_IMPORT_LEGACY_FILES` | 是否导入旧文件               | 新部署设为 `false`               |

## 旧文件存储迁移

如果已有 `.codebuddy_creds` 或旧 JSON 配置，第一次启动 SQLite 时暂时不要设置 `CODEBUDDY_STORAGE_IMPORT_LEGACY_FILES=false`，并额外挂载旧凭据目录：

```bash
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

| 变量                             | 说明                    | 示例 / 默认值                 |
| -------------------------------- | ----------------------- | ----------------------------- |
| `CODEBUDDY_API_ENDPOINT`         | 上游 CodeBuddy API 地址 | `https://copilot.tencent.com` |
| `CODEBUDDY_AUTH_MODE`            | 上游认证模式            | `auto` / `token`              |
| `CODEBUDDY_INTERNET_ENVIRONMENT` | 网络环境                | `internal` / `ioa` / `public` |
| `CODEBUDDY_LOG_LEVEL`            | 日志级别                | `INFO`                        |
| `CODEBUDDY_ADMIN_PASSKEY_RP_ID`  | Passkey 使用的 hostname | `example.com`                 |
