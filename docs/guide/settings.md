# 设置

设置页用于修改上游连接方式、模型列表、用量记录和控制台登录方式。

## 服务配置

填写或选择以下项目后点击「保存」：

| 页面字段                        | 说明                                               |
| ------------------------------- | -------------------------------------------------- |
| CodeBuddy 官方 API 端点         | 上游地址，默认 `https://copilot.tencent.com`       |
| 管理员 Passkey RP ID / 域名     | WebAuthn 使用的 hostname，不要填写协议或端口       |
| 认证模式（auto/token）          | 上游认证方式                                       |
| 网络环境（internal/ioa/public） | 上游网络环境                                       |
| 日志级别                        | 选择 `DEBUG`、`INFO`、`WARNING` 或 `ERROR`         |
| API 超时时间,首个 token(分钟)   | 首个 delta 迟迟不返回时中断请求；默认 `5`          |
| WebSearch 后端                  | `web_search` 使用的搜索引擎，单选；详见下文        |
| WebFetch 后端                   | `web_fetch` 使用的后端，多选、按顺序尝试；详见下文 |

API 超时时间从发起请求开始计时，直到上游返回第一个 delta，因此它限制的是「迟迟没有开始输出」的等待
时间。一旦开始输出，即使回答较长也会允许其完成。支持小数分钟，取值范围 `0.1`~`1440`。也可以在打开
控制台之前通过环境变量 `CODEBUDDY_API_TIMEOUT_MINUTES` 预设该值。

### 思考档位

每个客户端用自己的词表表达思考深度：Claude Code 发 Anthropic `thinking`，Codex 发 Responses
`reasoning.effort`，Chat 客户端发 `reasoning_effort`。上游只接受一个档位值，因此 `/v1/messages`
与 `/v1/responses` 会把请求归到同一条阶梯（`off` → `low` → `medium` → `high` → `xhigh`）上，
再发送一个档位：

- 目录中有描述的模型：取它声明的最接近档位，并保留模型自己的拼写。例如 `hy3-x` 声明了
  `low` 与 `high`，那么 `xhigh` 和 `medium` 都会落到 `high`。
- 目录中没有描述的模型：把阶梯映射到上游自己使用的取值——`low`、`medium`、`high`、`max`。
  `xhigh` 不在其中，会落到 `high`。
- 上游声明完全不支持推理的模型：不发送任何思考字段。

思考无法关闭：所有声明了档位的模型都带 `canDisableThinking: false`，因此「不思考」的请求会落到
可选的最浅档位，而不是上游并不接受的「none」。Anthropic 的 `thinking` 字段在被读取之后会被移除，
避免用两种词表重复表达同一件事；但代理读不懂的词表会原样转发。

## 服务器工具

Anthropic 客户端把搜索和抓取声明为服务端工具（`web_search_20260209`、
`web_fetch_20250910`），Codex 则声明 `web_search_preview`。CodeBuddy 没有对应的
服务端工具，因此当客户端声明了它们时，本服务会替换成普通的函数工具、自己执行，再把结果
作为 tool 消息追加回去。模型照常作答，客户端并不知道这一步是在本地完成的。

### WebSearch 后端

`web_search` 由选中的一个引擎执行。所有引擎都会显示（与是否已配置无关），选中后会出现
该引擎需要的配置项：

| 后端         | 配置项                      | 说明                                                     |
| ------------ | --------------------------- | -------------------------------------------------------- |
| `codebuddy`  | 无                          | 调用 CodeBuddy 的 `/agenttool/v1/search`，需要已保存凭证 |
| `searxng`    | 实例地址（含端口）、API Key | 查询你自己的 SearXNG 实例。默认值，Key 可选              |
| `duckduckgo` | 区域                        | 不需要任何凭证，返回整理过的即时答案                     |
| `brave`      | API Key                     | Brave Search，独立索引                                   |
| `tavily`     | API Key                     | 返回页面正文而不只是摘要                                 |
| `serper`     | API Key                     | 通过 Serper 获取 Google 结果                             |
| `bing`       | API Key                     | Bing Web Search                                          |
| `exa`        | API Key                     | 按语义匹配的搜索                                         |

无法运行的引擎（Key 没填、SearXNG 没填地址）会解析为「没有后端」，该工具会从请求中移除，
而不是对外宣称后必定失败。默认值之所以是 `searxng`，正是因为新部署没有地址，在填入之前
不会对外承诺任何东西。唯一的例外是 `codebuddy`：它不需要任何配置，因此只要选中就会生效，缺少
凭证时会返回一次失败的搜索，而不是被移除。

列表最后一项**关闭**用于停用：选择它（或设置 `CODEBUDDY_WEB_SEARCH_BACKEND=none`）后本服务
不再执行 `web_search`，客户端声明的该工具会从请求中移除。升级前保存为 `none` 的部署，升级后
仍然是关闭。

### WebFetch 后端

可以多选，按选择顺序依次尝试，第一个成功的即被采用。多选举手之劳却有实际意义：有的页面
拒绝直接抓取，而用浏览器抓取又比直接抓取慢得多，两者的失败方式不同。

| 后端            | 配置项        | 说明                                                             |
| --------------- | ------------- | ---------------------------------------------------------------- |
| `codebuddy`     | 无            | 调用 CodeBuddy 的 `/agenttool/v1/webfetch`，失败时回退为直接抓取 |
| `codebuddy2api` | 无            | 本服务直接抓取页面，并把 HTML 转为文本。默认值                   |
| `browserable`   | 地址、API Key | 用 Browserable 部署驱动真实浏览器。Key 可选                      |
| `jina`          | API Key       | Jina Reader 以 Markdown 返回页面。Key 可选                       |

一个都不选即为关闭该工具。`web_fetch` 现在默认由本服务本地执行，因此原先保持 `passthrough`
的部署在升级后会开始自行抓取页面——清空选择即可恢复。

之所以提供 `codebuddy`，是因为它就是 CodeBuddy CLI 自己调用的那个端点：不需要额外部署
任何东西，直接用网关里已保存的凭证鉴权。

`codebuddy2api` 抓取后端把 URL 当作不可信输入——它来自模型：连接建立前就会拒绝私有地址和
本机回环地址，并且每一跳重定向都会重新校验，因此公开的 URL 无法重定向到部署自身的网络。

两项选择都可以在打开控制台之前用 `CODEBUDDY_WEB_SEARCH_BACKEND`、
`CODEBUDDY_WEB_FETCH_BACKEND`（后者为逗号分隔的列表）预设；每个后端自己的配置也有对应的
环境变量（`CODEBUDDY_SEARXNG_URL`、`CODEBUDDY_BRAVE_API_KEY`、
`CODEBUDDY_BROWSERABLE_URL` 等）。SearXNG 在控制台留空时仍会读取 `SEARXNG_URL`
与 `SEARXNG_API_KEY`。

## 凭证模型和用量

- 「凭证模型」列出每个凭证支持的模型；可以编辑模型列表，或点击「刷新」重新获取。
- 「用量统计缓存」中的「清空用量统计缓存」会删除全部用量记录，且无法撤销。

## 控制台安全

在「控制台安全」中设置管理员用户名、密码和确认密码，点击「保存」启用登录保护。关闭鉴权后，知道地址的用户可以直接打开控制台。
