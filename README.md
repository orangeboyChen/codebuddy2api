# CodeBuddy2API

将腾讯 CodeBuddy（Copilot）官方接口包装成与 OpenAI API 格式兼容的代理服务。本项目面向**腾讯内部 iOA 网络环境**，直接调用 `https://copilot.tencent.com`，为所有标准 OpenAI 客户端提供统一接口。

> Docker Compose 一键部署请查看 [USAGE.md](./USAGE.md)。

## 🌟 功能特性

- 🔌 **OpenAI 兼容接口**：提供标准 `/v1/*` 路径，无缝对接 `openai` SDK 及各类第三方客户端。
- 💬 **双接口支持**：支持 `Chat Completions`（`/v1/chat/completions`）与 `Responses`（`/v1/responses`，OpenAI Responses API）。
- 🔄 **智能响应处理**：即使 CodeBuddy 上游仅支持流式响应，本服务也能为非流式请求在后端完成“流式转非流式”聚合。
- 🔐 **iOA 内部登录认证**：通过腾讯内部 iOA OAuth 流程获取 Bearer Token，Web 管理界面一键登录授权，无需手动复制 Token，也无需配置任何 API Key。
- 🔄 **凭证自动轮换**：支持在 `.codebuddy_creds` 目录配置多个凭证，按 `CODEBUDDY_ROTATION_COUNT` 自动轮换，也可在 Web UI 手动指定或关闭轮换。
- 🌐 **Web 管理界面**：内置管理面板，用于凭证管理、API 测试、服务状态查看与配置热更新。
- ⚡ **高性能**：基于 FastAPI + asyncio + Hypercorn 构建，支持高并发异步请求。

## 🚀 快速开始

iOA 网络环境下，所有配置均已内置合理默认值，**无需设置任何环境变量**，启动后完成一次 iOA 登录即可使用。

### 1. 前置要求

- Python 3.8 或更高版本
- Git
- **腾讯内部网络环境**：需能够访问 `https://copilot.tencent.com`（iOA 内网）

### 2. 下载和安装

```bash
git clone https://github.com/orangeboyChen/CodeBuddy2api.git
cd CodeBuddy2api
```

创建虚拟环境并安装依赖：

```bash
python3 -m venv venv
source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

### 3. 启动服务

```bash
# 确保已激活虚拟环境
python web.py
```

Windows 也可直接运行 `start.bat`。默认监听 `http://127.0.0.1:8001`。

> 默认配置已适配 iOA：网络环境 `ioa`、端点 `https://copilot.tencent.com`、认证模式 `auto`（无 API Key 时自动使用 iOA 登录获取的凭证）、凭证目录 `.codebuddy_creds`。开箱即用，无需修改任何环境变量。

### 4. 通过 iOA 登录获取凭证

本服务通过腾讯内部 iOA OAuth 流程获取 CodeBuddy 的 Bearer Token，推荐使用 Web 管理界面自动完成：

1. 启动服务后，使用浏览器访问 `http://127.0.0.1:8001`。
2. 打开即为管理面板，开箱即用。
3. 进入 **凭证管理** 标签页。
4. 在 **自动获取认证** 卡片中点击 **开始认证**。
5. 系统会调用 CodeBuddy 的 `/v2/plugin/auth/state` 生成一个 iOA 登录链接（`authUrl`）。点击 **打开链接**。
6. 在打开的腾讯内部登录页面中完成 iOA 授权登录。
7. 登录成功后关闭登录页面，本服务会自动轮询 `/v2/plugin/auth/token` 检测登录状态，并在成功后自动获取、解析并保存新的 Bearer Token 凭证。点击 **刷新列表** 即可看到新添加的凭证。

> 默认轮询间隔 5 秒，state 有效期 1800 秒（30 分钟）。凭证文件以 JSON 形式保存在 `.codebuddy_creds/` 目录下。完成此步后即可开始调用 API。

## ⚙️ API 使用

### 客户端集成示例

任何支持 OpenAI API 的客户端均可指向本服务。以下示例使用默认模型 `glm-5.1`。

**Python（openai SDK）：**

```python
import openai

client = openai.OpenAI(
    api_key="any",
    base_url="http://127.0.0.1:8001/v1"
)

# 非流式
response = client.chat.completions.create(
    model="glm-5.1",
    messages=[{"role": "user", "content": "你好，2+2 等于几？"}]
)
print(response.choices[0].message.content)

# 流式
stream = client.chat.completions.create(
    model="glm-5.1",
    messages=[{"role": "user", "content": "写一个 Python Hello World 脚本"}],
    stream=True
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")
```

**curl 示例：**

```bash
curl -X POST "http://127.0.0.1:8001/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-5.1",
    "messages": [{"role": "user", "content": "你是什么模型"}],
    "stream": false
  }'
```

**Responses API：**

```bash
curl -X POST "http://127.0.0.1:8001/v1/responses" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.5",
    "input": "写一个 Python Hello World 脚本",
    "stream": false
  }'
```

```python
import openai

client = openai.OpenAI(
    api_key="any",
    base_url="http://127.0.0.1:8001/v1"
)

resp = client.responses.create(
    model="gpt-5.5",
    input="你好，2+2 等于几？"
)
print(resp.output_text)
```

> 说明：
> - `stream=true` 时直接透传上游 SSE 事件流（`response.created` / `response.output_text.delta` / `response.completed` 等）。
> - `stream=false` 时在后端以流式请求上游并聚合为单个 Response 对象返回。

## 📝 API 端点

为兼容标准 OpenAI 客户端，以下端点统一使用 `/v1/*` 路径前缀：

- `POST /v1/chat/completions`：聊天接口（Chat Completions）。
- `POST /v1/responses`：Responses 接口（OpenAI Responses API）。
- `GET /v1/models`：获取当前配置的可用模型列表。
- `GET /v1/credentials`：（需认证）列出所有凭证。
- `POST /v1/credentials`：（需认证）添加新凭证。
- `POST /v1/credentials/select`：（需认证）手动指定使用某个凭证。
- `POST /v1/credentials/auto`：（需认证）恢复自动轮换。
- `POST /v1/credentials/toggle-rotation`：（需认证）切换自动轮换开关。
- `GET /v1/credentials/current`：（需认证）获取当前使用中的凭证信息。
- `POST /v1/credentials/delete`：（需认证）按索引删除凭证。
- `GET /codebuddy/auth/start`：启动 iOA 登录认证流程。
- `POST /codebuddy/auth/poll`：轮询登录状态并获取 Token。
- `GET /codebuddy/auth/callback`：OAuth2 回调端点。
- `GET /health`：健康检查端点。
- `GET /api/settings` / `POST /api/settings`：读取与保存服务配置（热更新）。

## 🔧 项目结构

```
CodeBuddy2api/
├── src/                           # 源代码目录
│   ├── auth.py                    # 服务访问认证模块
│   ├── codebuddy_api_client.py    # 封装与 CodeBuddy 官方 API 的通信
│   ├── codebuddy_auth_router.py   # iOA OAuth2 认证路由
│   ├── codebuddy_token_manager.py # 凭证加载与轮换管理器
│   ├── codebuddy_router.py        # 核心 API 路由 (v1)
│   ├── frontend_router.py         # Web 管理界面路由
│   ├── settings_router.py         # 设置管理路由（热更新）
│   ├── usage_stats_manager.py     # 使用统计管理器
│   └── keyword_replacer.py        # 关键词替换模块
├── frontend/
│   └── admin.html                 # Web 管理界面前端页面
├── config/                        # 持久化配置目录（config/config.json）
├── .codebuddy_creds/              # 存放 CodeBuddy 凭证的目录（Git 忽略其内容）
├── web.py                         # FastAPI 服务主入口
├── config.py                      # 多层配置管理（热重载）
├── requirements.txt               # Python 依赖列表
├── docker-compose.yml             # Docker Compose 配置
├── Dockerfile                     # Docker 镜像构建文件
├── entrypoint.sh                  # Docker 容器入口脚本
├── start.bat                      # Windows 启动脚本
└── README.md                      # 本文档
```

## ⚙️ 配置选项

iOA 场景下所有配置均有内置默认值，开箱即用，**无需手动设置任何环境变量**。如需调整，推荐通过 Web 管理界面的「设置」页面修改，改动会即时生效并持久化到 `config/config.json`。

配置优先级（由高到低）：Web UI 内存热更新 > `config/config.json` > 环境变量 / `.env` > 内置默认值。

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CODEBUDDY_HOST` | `127.0.0.1` | 服务监听地址，Docker 部署需设为 `0.0.0.0`。 |
| `CODEBUDDY_PORT` | `8001` | 服务监听端口。 |
| `CODEBUDDY_API_ENDPOINT` | `https://copilot.tencent.com` | CodeBuddy 官方端点，iOA 环境无需修改。 |
| `CODEBUDDY_INTERNET_ENVIRONMENT` | `ioa` | 网络环境，iOA 场景固定为 `ioa`，无需修改。 |
| `CODEBUDDY_AUTH_MODE` | `auto` | 认证模式：`auto` 优先用 API Key，否则使用 iOA 登录的 token 凭证。iOA 场景保持默认即可。 |
| `CODEBUDDY_API_KEY` | 空 | API Key 直连模式用。iOA 登录场景留空即可。 |
| `CODEBUDDY_CREDS_DIR` | `.codebuddy_creds` | 存放凭证 JSON 文件的目录。 |
| `CODEBUDDY_LOG_LEVEL` | `INFO` | 日志级别：`DEBUG` / `INFO` / `WARNING` / `ERROR`。 |
| `CODEBUDDY_MODELS` | 内置模型列表 | 向客户端报告的可用模型，逗号分隔，含普通模型与 `-ioa` 后缀模型。 |
| `CODEBUDDY_SSL_VERIFY` | `false` | SSL 验证开关，设为 `true` 启用。iOA 内网默认关闭。 |
| `CODEBUDDY_ROTATION_COUNT` | `1` | 凭证轮换计数，每 N 次请求切换下一个凭证。设为 `0` 则不自动轮换。 |

## 🐛 故障排除

- **"No valid CodeBuddy credentials found"**：尚未通过 iOA 登录获取凭证，或 `.codebuddy_creds/` 下没有有效的凭证 JSON。请在 Web UI 的凭证管理中点击“开始认证”完成 iOA 登录。
- **"API error: 401" / "API error: 403"（来自 CodeBuddy）**：Bearer Token 无效或已过期。请重新通过 iOA 登录获取新凭证，或删除过期凭证后重新认证。
- **认证链接无法打开 / 登录超时**：确认当前处于腾讯内部 iOA 网络环境，能访问 `https://copilot.tencent.com`；state 有效期 30 分钟，超时后需重新点击“开始认证”。
- **需要查看详细日志**：在 Web UI 设置中将 `CODEBUDDY_LOG_LEVEL` 改为 `DEBUG`，或设置环境变量后重启服务。

## 📄 许可证

详见 [LICENSE](./LICENSE)。
