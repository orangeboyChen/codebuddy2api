# 本地运行（开发）

本地运行主要用于开发和调试，不是生产部署方式。

```bash
bun install
mkdir -p .codebuddy_data .codebuddy_creds
bun run dev
```

打开 `http://127.0.0.1:3000/dashboard`。`.codebuddy_creds` 用于兼容旧文件认证；SQLite 开发时可只使用 `.codebuddy_data`。
