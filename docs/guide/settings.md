# 设置

设置页用于修改上游连接方式、模型列表、用量记录和控制台登录方式。

## 服务配置

填写或选择以下项目后点击「保存」：

| 页面字段                        | 说明                                                    |
| ------------------------------- | ------------------------------------------------------- |
| CodeBuddy 官方 API 端点         | 上游地址，默认 `https://copilot.tencent.com`            |
| 管理员 Passkey RP ID / 域名     | WebAuthn 使用的 hostname，不要填写协议或端口            |
| 认证模式（auto/token）          | 上游认证方式                                            |
| 网络环境（internal/ioa/public） | 上游网络环境                                            |
| 日志级别                        | 选择 `DEBUG`、`INFO`、`WARNING` 或 `ERROR`              |
| API 超时时间,首个 token(分钟)   | 首个 delta 迟迟不返回时中断请求；默认 `5`               |
| 启用本地 WebSearch              | 在本地执行 `web_search` 而不是转发给上游；默认关闭      |
| WebSearch 后端                  | `web_search` 的执行位置：`codebuddy`、`searxng`、`none` |
| 启用本地 WebFetch               | 在本地执行 `web_fetch` 而不是转发给上游；默认关闭       |
| WebFetch 后端                   | `web_fetch` 的执行位置：`codebuddy`、`local`、`none`    |
| 为 Hy 系列模型转换思想深度      | 把下游思考参数转为上游的 `reasoning_effort`；默认关闭   |

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

## 服务器工具

Anthropic 客户端把搜索和抓取声明为服务端工具（`web_search_20260209`、
`web_fetch_20250910`），Codex 则声明 `web_search_preview`。CodeBuddy 没有对应的
服务端工具，因此当客户端声明了它们时，本服务会替换成普通的函数工具、自己执行，再把结果
作为 tool 消息追加回去。模型照常作答，客户端并不知道这一步是在本地完成的。

两个工具各自独立选择后端：

| 工具         | 后端        | 行为                                                         |
| ------------ | ----------- | ------------------------------------------------------------ |
| `web_search` | `codebuddy` | 用已保存的凭证调用 CodeBuddy 的 `/agenttool/v1/search`       |
| `web_search` | `searxng`   | 查询 SearXNG 实例。默认值，需要配置 `SEARXNG_URL`            |
| `web_fetch`  | `codebuddy` | 调用 CodeBuddy 的 `/agenttool/v1/webfetch`，返回抽取后的文本 |
| `web_fetch`  | `local`     | 本服务直接抓取页面，并把 HTML 转为文本                       |
| 两者皆可     | `none`      | 从不执行该工具，并从请求中移除它                             |

之所以提供 `codebuddy`，是因为它就是 CodeBuddy CLI 自己调用的那个端点：不需要额外部署
任何东西，直接用网关里已保存的凭证鉴权。`searxng` 保持为默认值，这样已有部署不受影响；
未设置 `SEARXNG_URL` 时控制台会直接隐藏搜索相关设置，避免部署对外宣称一个自己执行不了的
工具。

`local` 抓取后端把 URL 当作不可信输入——它来自模型：连接建立前就会拒绝私有地址和本机
回环地址，并且每一跳重定向都会重新校验，因此公开的 URL 无法重定向到部署自身的网络。

没有独立的启用开关：`none` 就是「关闭」，因此后端选择不可能自相矛盾。两者默认都是
`none`。可以在打开控制台之前用 `CODEBUDDY_WEB_SEARCH_BACKEND`、
`CODEBUDDY_WEB_FETCH_BACKEND` 预设。

## 凭证模型和用量

- 「凭证模型」列出每个凭证支持的模型；可以编辑模型列表，或点击「刷新」重新获取。
- 「用量统计缓存」中的「清空用量统计缓存」会删除全部用量记录，且无法撤销。

## 控制台安全

在「控制台安全」中设置管理员用户名、密码和确认密码，点击「保存」启用登录保护。关闭鉴权后，知道地址的用户可以直接打开控制台。
