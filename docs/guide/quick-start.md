# 快速开始

## 本地运行 CodeBuddy2API

需要 Bun 1.3.14+ 和 Node.js 20+：

```bash
bun install
mkdir -p .codebuddy_data .codebuddy_creds
bun run dev
```

然后访问 `http://127.0.0.1:3000/dashboard`。

## 本地运行文档

从仓库根目录执行 `bun install --cwd docs`，再执行 `bun run docs:dev`。文档站通常位于 `http://127.0.0.1:5173/codebuddy2api/`。

## Docker 运行（SQLite）

```bash
docker run -d \
  --name codebuddy2api \
  --restart unless-stopped \
  -p 8001:8001 \
  -e CODEBUDDY_STORAGE_BACKEND=sqlite \
  -e CODEBUDDY_STORAGE_ENCRYPTION_KEY='replace-with-a-long-random-secret' \
  -e CODEBUDDY_STORAGE_IMPORT_LEGACY_FILES=false \
  -v "$(pwd)/.codebuddy_data:/app/.codebuddy_data" \
  ghcr.io/orangeboyChen/codebuddy2api:latest
```

管理控制台地址为 `http://127.0.0.1:8001/dashboard`。

首次使用建议按以下顺序操作：

1. 在“凭据”页完成 CodeBuddy 自动认证。
2. 在“账号状态”页刷新配额并确认目标模型可用。
3. 在“凭据”页创建 API key。
4. 在“API 测试”页发送一条测试消息。
5. 将 `/v1` 地址和 API key 配置到你的客户端。

## 存储选择

当前默认后端仍是 `file`，用于兼容已有部署。单实例生产环境推荐显式启用 SQLite：

```dotenv
CODEBUDDY_STORAGE_BACKEND=sqlite
CODEBUDDY_STORAGE_SQLITE_PATH=.codebuddy_data/storage.sqlite
CODEBUDDY_STORAGE_ENCRYPTION_KEY=replace-with-a-long-random-secret
```

多实例部署请使用 PostgreSQL。数据库后端需要设置 `CODEBUDDY_STORAGE_ENCRYPTION_KEY`。
