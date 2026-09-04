# 设置

设置页用于修改运行时配置和控制台安全选项。

## 服务设置

- **CodeBuddy API endpoint**：上游地址，默认 `https://copilot.tencent.com`。
- **Admin passkey RP ID / domain**：WebAuthn 使用的域名，只填写 hostname。
- **Authentication mode**：选择 `auto` 或 `token`。
- **Network environment**：选择 `internal`、`ioa` 或 `public`。
- **Log level**：选择日志级别，默认 `INFO`。

修改后点击对应的“保存”。

## 其他设置

- **Credential models**：查看每个凭据支持的模型并单独刷新。
- **Usage event cache**：点击“清除用量事件缓存”删除用量数据，不能恢复。
- **Console security**：设置管理员用户名、密码和确认密码。启用后未登录用户会被重定向到登录页。
