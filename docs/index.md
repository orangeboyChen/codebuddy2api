---
layout: home

hero:
  name: CodeBuddy2API
  text: CodeBuddy 管理与 API 服务
  tagline: 自托管 CodeBuddy，统一管理凭据、密钥和用量。
  image:
    src: /codebuddy2api/codebuddy-dashboard.png
    alt: CodeBuddy 管理界面
  actions:
    - theme: brand
      text: 开始使用
      link: /guide/quick-start
    - theme: alt
      text: 查看 GitHub
      link: https://github.com/orangeboyChen/codebuddy2api

features:
  - title: 多协议兼容
    details: 同时提供 OpenAI-compatible 和 Anthropic-compatible API。
  - title: 内置管理控制台
    details: 管理凭据、访问密钥、用量、调试日志和运行时设置。
  - title: 灵活存储
    details: 默认零配置文件存储，也支持 SQLite 和 PostgreSQL。
---

## 这是什么？

CodeBuddy2API 提供 CodeBuddy 的 OpenAI-compatible 和 Anthropic-compatible API，并配套一个管理控制台。你可以在本地、Docker 或 Kubernetes 中运行它。

## 开始使用

```bash
docker run -d \
  --name codebuddy2api \
  --restart unless-stopped \
  -p 8001:8001 \
  -e CODEBUDDY_STORAGE_BACKEND=sqlite \
  -e CODEBUDDY_STORAGE_ENCRYPTION_KEY='replace-with-a-long-random-secret' \
  -v "$(pwd)/.codebuddy_data:/app/.codebuddy_data" \
  -v "$(pwd)/.codebuddy_creds:/app/.codebuddy_creds" \
  ghcr.io/orangeboychen/codebuddy2api:latest
```

启动后访问 `http://127.0.0.1:8001/dashboard`。

SQLite 是单实例部署的推荐选择。多实例部署请改用 PostgreSQL。
