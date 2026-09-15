# 设置

设置页用于修改上游连接方式、模型列表、用量记录和控制台登录方式。

## 服务配置

填写或选择以下项目后点击「保存」：

| 页面字段                        | 说明                                                  |
| ------------------------------- | ----------------------------------------------------- |
| CodeBuddy 官方 API 端点         | 上游地址，默认 `https://copilot.tencent.com`          |
| 管理员 Passkey RP ID / 域名     | WebAuthn 使用的 hostname，不要填写协议或端口          |
| 认证模式（auto/token）          | 上游认证方式                                          |
| 网络环境（internal/ioa/public） | 上游网络环境                                          |
| 日志级别                        | 选择 `DEBUG`、`INFO`、`WARNING` 或 `ERROR`            |
| API 超时时间,首个 token(分钟)   | 首个 delta 迟迟不返回时中断请求；默认 `5`             |
| 为 Hy 系列模型转换思想深度      | 把下游思考参数转为上游的 `reasoning_effort`；默认关闭 |

API 超时时间从发起请求开始计时，直到上游返回第一个 delta，因此它限制的是「迟迟没有开始输出」的等待
时间。一旦开始输出，即使回答较长也会允许其完成。支持小数分钟，取值范围 `0.1`~`1440`。也可以在打开
控制台之前通过环境变量 `CODEBUDDY_API_TIMEOUT_MINUTES` 预设该值。

Hy 系列模型（`hy3` 等）只接受 `reasoning_effort` 的 `no_think` / `low` / `high` 三档，而下游客户端
并不使用这套词表：Claude Code 发送 Anthropic `thinking`，Codex 发送 Responses `reasoning.effort`。
开启后，本服务会把两者转换到 Hy 的词表：

| 下游取值                                     | 转换结果   |
| -------------------------------------------- | ---------- |
| `thinking.type: disabled`、`minimal`、`none` | `no_think` |
| `budget_tokens` ≤ 8K、`low`、`medium`        | `low`      |
| `budget_tokens` > 8K、`high`、`xhigh`、`max` | `high`     |

模型名以 `hy` 开头即视为 Hy 模型（忽略大小写），因此 `hy3`、`hy3-ioa`、以及未来的 `hy4` 都会生效；
`hunyuan-*` 是另一个前缀、属于不同产品线，不会被匹配。转换成功后，原始的 `thinking` 字段会被移除，
避免用两种词表重复表达同一件事、也避免上游因收到不认识的结构而报错。默认关闭，即原样转发、不做任何
转换。也可以通过环境变量 `CODEBUDDY_HY_THOUGHT_DEPTH_ENABLED` 预设（`true` / `false`）。

## 凭证模型和用量

- 「凭证模型」列出每个凭证支持的模型；可以编辑模型列表，或点击「刷新」重新获取。
- 「用量统计缓存」中的「清空用量统计缓存」会删除全部用量记录，且无法撤销。

## 控制台安全

在「控制台安全」中设置管理员用户名、密码和确认密码，点击「保存」启用登录保护。关闭鉴权后，知道地址的用户可以直接打开控制台。
