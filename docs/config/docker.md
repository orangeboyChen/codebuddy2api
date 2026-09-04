# Docker 与存储配置

## SQLite（单实例）

SQLite 是单实例部署的推荐后端。下面的命令可以直接启动，不要求挂载 volume：

```bash
docker run -d --name codebuddy2api --restart unless-stopped -p 8001:8001 \
  -e CODEBUDDY_STORAGE_BACKEND=sqlite \
  -e CODEBUDDY_STORAGE_ENCRYPTION_KEY='replace-with-a-long-random-secret' \
  -e CODEBUDDY_STORAGE_IMPORT_LEGACY_FILES=false \
  ghcr.io/orangeboychen/codebuddy2api:latest
```

SQLite 文件默认位于容器内的 `/app/.codebuddy_data/storage.sqlite`。如果要在容器删除或重建后保留数据，请增加 `-v codebuddy2api-data:/app/.codebuddy_data`。

启动后打开 `http://127.0.0.1:8001/dashboard`。

## PostgreSQL（多实例）

多实例部署使用 PostgreSQL：

```bash
-e CODEBUDDY_STORAGE_BACKEND=pg \
-e DATABASE_URL='postgres://user:password@db:5432/codebuddy2api' \
-e CODEBUDDY_STORAGE_ENCRYPTION_KEY='replace-with-a-long-random-secret'
```

## 旧文件迁移

如果已有 `.codebuddy_creds` 或旧 JSON 配置，首次启动数据库后端时不要设置 `CODEBUDDY_STORAGE_IMPORT_LEGACY_FILES=false`，并临时挂载旧目录：

```bash
-v "$(pwd)/.codebuddy_creds:/app/.codebuddy_creds"
```

确认迁移完成后，设置 `CODEBUDDY_STORAGE_IMPORT_LEGACY_FILES=false`，并移除旧目录挂载。

## 环境变量

| 变量                                    | 作用                                   | 示例 / 默认值                                    |
| --------------------------------------- | -------------------------------------- | ------------------------------------------------ |
| `CODEBUDDY_STORAGE_BACKEND`             | 存储后端                               | `file`、`sqlite` 或 `pg`                         |
| `CODEBUDDY_STORAGE_SQLITE_PATH`         | SQLite 文件路径                        | `.codebuddy_data/storage.sqlite`                 |
| `CODEBUDDY_STORAGE_ENCRYPTION_KEY`      | 加密数据库中的敏感数据；数据库后端必填 | 长随机字符串                                     |
| `CODEBUDDY_STORAGE_IMPORT_LEGACY_FILES` | 是否从旧文件导入数据                   | 新部署设为 `false`                               |
| `DATABASE_URL`                          | PostgreSQL 连接字符串                  | `postgres://user:password@db:5432/codebuddy2api` |
| `CODEBUDDY_API_ENDPOINT`                | 上游 CodeBuddy API 地址                | `https://copilot.tencent.com`                    |
| `CODEBUDDY_AUTH_MODE`                   | 上游认证模式                           | `auto` / `token`                                 |
| `CODEBUDDY_INTERNET_ENVIRONMENT`        | 网络环境                               | `internal` / `ioa` / `public`                    |
| `CODEBUDDY_LOG_LEVEL`                   | 日志级别                               | `INFO`                                           |
| `CODEBUDDY_ADMIN_PASSKEY_RP_ID`         | 管理员 Passkey 使用的 hostname         | `example.com`                                    |
