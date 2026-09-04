---
layout: home

hero:
  name: CodeBuddy2API
  text: OpenAI-compatible CodeBuddy gateway
  tagline: Self-host CodeBuddy behind a familiar API surface.
  actions:
    - theme: brand
      text: 快速开始
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

CodeBuddy2API 将 CodeBuddy 接入常见的 LLM 客户端和 SDK。你可以在本地、Docker 或 Kubernetes 中运行它，并通过统一的 API 地址接入现有工具。

## 开始使用

```bash
docker run -d \
  --name codebuddy2api \
  --restart unless-stopped \
  -p 8001:8001 \
  -v "$(pwd)/.codebuddy_data:/app/.codebuddy_data" \
  -v "$(pwd)/.codebuddy_creds:/app/.codebuddy_creds" \
  ghcr.io/orangeboychen/codebuddy2api:latest
```

启动后访问 `http://127.0.0.1:8001/dashboard`。
