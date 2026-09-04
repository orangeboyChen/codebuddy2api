# 快速开始

## Docker 运行（SQLite）

```bash
docker run -d \
  --name codebuddy2api \
  --restart unless-stopped \
  -p 8001:8001 \
  -e CODEBUDDY_STORAGE_BACKEND=sqlite \
  -e CODEBUDDY_STORAGE_ENCRYPTION_KEY='replace-with-a-long-random-secret' \
  -e CODEBUDDY_STORAGE_IMPORT_LEGACY_FILES=false \
  ghcr.io/orangeboyChen/codebuddy2api:latest
```

管理控制台地址为 `http://127.0.0.1:8001/dashboard`。

首次使用建议按以下顺序操作：

1. 在“凭据”页完成 CodeBuddy 自动认证。
2. 在“账号状态”页刷新配额并确认目标模型可用。
3. 在“凭据”页创建 API key。
4. 在“API 测试”页发送一条测试消息。
5. 将 `/v1` 地址和 API key 配置到你的客户端。
