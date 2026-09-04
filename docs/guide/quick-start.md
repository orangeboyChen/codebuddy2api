# 快速开始

## 本地运行

需要 Bun 1.3.14+ 和 Node.js 20+：

```bash
bun install
bun install --cwd docs
bun run docs:dev
```

然后访问 `http://127.0.0.1:3000/dashboard`。

## Docker 运行

```bash
docker run -d \
  --name codebuddy2api \
  --restart unless-stopped \
  -p 8001:8001 \
  -v "$(pwd)/.codebuddy_data:/app/.codebuddy_data" \
  -v "$(pwd)/.codebuddy_creds:/app/.codebuddy_creds" \
  ghcr.io/orangeboyChen/codebuddy2api:latest
```

管理控制台地址为 `http://127.0.0.1:8001/dashboard`。

## 存储选择

当前默认后端是 `file`，适合零配置启动和兼容已有部署。单实例生产环境推荐使用 SQLite：

```dotenv
CODEBUDDY_STORAGE_BACKEND=sqlite
CODEBUDDY_STORAGE_SQLITE_PATH=.codebuddy_data/storage.sqlite
CODEBUDDY_STORAGE_ENCRYPTION_KEY=replace-with-a-long-random-secret
```

多实例部署请使用 PostgreSQL。数据库后端需要设置 `CODEBUDDY_STORAGE_ENCRYPTION_KEY`。
