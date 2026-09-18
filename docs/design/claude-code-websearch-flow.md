# Claude Code WebSearch 完整链路

## 1. 架构

你的实际架构：

```text
┌─────────────────────┐
│     Claude Code     │
│      客户端 CC       │
└──────────┬──────────┘
           │
           │ Anthropic Messages 协议
           │ POST /v1/messages
           ▼
┌────────────────────────────┐
│       你的兼容层            │
│   对外伪装 Anthropic API    │
│                            │
│   /v1/messages             │
└──────────┬─────────────────┘
           │
           │ OpenAI-compatible
           │ Chat Completions
           ▼
┌────────────────────────────┐
│       上游 Chat API         │
│   POST /v1/chat/completions │
└────────────────────────────┘
```

整个 WebSearch 流程里实际上存在两种不同的工具：

```text
WebSearch
```

和：

```text
web_search
```

它们不是同一个东西。

| 工具                                 | 类型                    | 谁声明                 | 谁执行             |
| ------------------------------------ | ----------------------- | ---------------------- | ------------------ |
| `WebSearch`                          | Claude Code client tool | Claude Code            | Claude Code        |
| `web_search_20250305` / `web_search` | Anthropic server tool   | Claude Code 的内部请求 | `/messages` 服务端 |
| 你转给 Chat 的 `web_search`          | 普通 function           | 你的兼容层             | 你的兼容层         |

因为你的上游是普通 Chat API，所以：

```text
Anthropic server tool
```

不能直接一一映射成真正的 hosted server tool。

你需要在自己的兼容层里模拟 server-tool loop。

---

# 2. 第一阶段：Claude Code 主请求

用户在 Claude Code 中说：

```text
帮我查一下 OpenAI 最近有什么更新
```

Claude Code 向你的 `/v1/messages` 发请求。

例如：

```http
POST /v1/messages
```

```json
{
  "model": "claude-opus-...",
  "max_tokens": 32000,
  "messages": [
    {
      "role": "user",
      "content": "帮我查一下 OpenAI 最近有什么更新"
    }
  ],
  "tools": [
    {
      "name": "WebSearch",
      "description": "Search the web",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {
            "type": "string"
          },
          "allowed_domains": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "blocked_domains": {
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        },
        "required": ["query"]
      }
    },
    {
      "name": "Read",
      "description": "...",
      "input_schema": {}
    },
    {
      "name": "Bash",
      "description": "...",
      "input_schema": {}
    }
  ]
}
```

这里：

```text
WebSearch
```

是大写。

它是一个普通 Claude Code client tool。

所以你的兼容层：

```text
❌ 不应该在这里执行搜索
```

而是应该把它当普通 function tool 转给上游 Chat。

---

# 3. 第一次 `/messages` → `/chat/completions`

你的兼容层转换成：

```http
POST /v1/chat/completions
```

```json
{
  "model": "your-upstream-model",
  "messages": [
    {
      "role": "user",
      "content": "帮我查一下 OpenAI 最近有什么更新"
    }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "WebSearch",
        "description": "Search the web",
        "parameters": {
          "type": "object",
          "properties": {
            "query": {
              "type": "string"
            },
            "allowed_domains": {
              "type": "array",
              "items": {
                "type": "string"
              }
            },
            "blocked_domains": {
              "type": "array",
              "items": {
                "type": "string"
              }
            }
          },
          "required": ["query"]
        }
      }
    },
    {
      "type": "function",
      "function": {
        "name": "Read",
        "description": "...",
        "parameters": {}
      }
    }
  ]
}
```

---

# 4. 上游 Chat 决定调用 `WebSearch`

上游 Chat 返回：

```json
{
  "id": "chatcmpl-main-001",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": null,
        "tool_calls": [
          {
            "id": "call_search_001",
            "type": "function",
            "function": {
              "name": "WebSearch",
              "arguments": "{\"query\":\"OpenAI latest updates 2026\"}"
            }
          }
        ]
      },
      "finish_reason": "tool_calls"
    }
  ]
}
```

注意：

```text
name = WebSearch
```

还是大写的 Claude Code client tool。

你的兼容层把它转回 Anthropic：

```json
{
  "id": "msg_001",
  "type": "message",
  "role": "assistant",
  "content": [
    {
      "type": "tool_use",
      "id": "toolu_search_001",
      "name": "WebSearch",
      "input": {
        "query": "OpenAI latest updates 2026"
      }
    }
  ],
  "stop_reason": "tool_use"
}
```

然后：

```text
你的兼容层
     ↓
把 tool_use 返回 Claude Code
```

此时你的服务器：

```text
仍然没有搜索。
```

---

# 5. Claude Code 收到 `WebSearch`

Claude Code 收到：

```json
{
  "type": "tool_use",
  "id": "toolu_search_001",
  "name": "WebSearch",
  "input": {
    "query": "OpenAI latest updates 2026"
  }
}
```

此时执行：

```text
Claude Code 内置 WebSearch
```

也就是说：

```text
               第一次请求

Claude Code
     ↓
你的 /messages
     ↓
上游 Chat
     ↓
tool_call WebSearch
     ↓
你的 /messages
     ↓
tool_use WebSearch
     ↓
Claude Code
```

到这里第一阶段结束。

---

# 6. Claude Code 执行 WebSearch 时再次请求 `/messages`

Claude Code 为了实现这个 `WebSearch`，会创建一个内部的 side request。

这是：

```text
第二次独立的 /v1/messages 请求
```

示意结构：

```http
POST /v1/messages
```

```json
{
  "model": "claude-haiku-...",
  "max_tokens": 32000,
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "Perform a web search for the query: OpenAI latest updates 2026"
        }
      ]
    }
  ],
  "tools": [
    {
      "type": "web_search_20250305",
      "name": "web_search",
      "max_uses": 8
    }
  ],
  "tool_choice": {
    "type": "tool",
    "name": "web_search"
  }
}
```

注意第二次已经不是：

```text
WebSearch
```

而是：

```text
web_search
```

并且有特殊 type：

```text
web_search_20250305
```

这表示：

```text
Anthropic server tool
```

---

# 7. Query 怎么从第一次传到第二次？

第一阶段主模型产生：

```json
{
  "name": "WebSearch",
  "input": {
    "query": "OpenAI latest updates 2026"
  }
}
```

Claude Code 收到以后：

```text
query =
"OpenAI latest updates 2026"
```

然后 CC 的 WebSearch implementation 创建第二次 side request。

示意：

```text
WebSearch.input.query

"OpenAI latest updates 2026"

           ↓

       Claude Code

           ↓

第二次 /messages 输入

"Perform a web search for the query:
 OpenAI latest updates 2026"
```

重点是：

```text
web_search_20250305 的 tool definition
本身没有 query。
```

它只是：

```json
{
  "type": "web_search_20250305",
  "name": "web_search"
}
```

query 存在于这次模型输入的语义里。

之后模型应该生成：

```json
{
  "type": "server_tool_use",
  "name": "web_search",
  "input": {
    "query": "OpenAI latest updates 2026"
  }
}
```

Anthropic 原生 API 会在这里执行搜索。

但是：

```text
你不是 Anthropic。

你的上游也不是 Anthropic server-tool runtime。

你的上游是 Chat API。
```

所以这一部分需要你自己模拟。

---

# 8. 你的兼容层收到第二次 `/messages`

现在你收到：

```json
{
  "messages": [
    {
      "role": "user",
      "content": "Perform a web search for the query: OpenAI latest updates 2026"
    }
  ],
  "tools": [
    {
      "type": "web_search_20250305",
      "name": "web_search",
      "max_uses": 8
    }
  ],
  "tool_choice": {
    "type": "tool",
    "name": "web_search"
  }
}
```

这一次：

```text
✅ 你的服务端必须处理 web_search
```

因为从 Claude Code 看：

```text
你的 /messages API
=
Anthropic server
```

---

# 9. `web_search` server tool 怎么转换给 Chat？

普通 Chat API 不理解：

```json
{
  "type": "web_search_20250305"
}
```

所以你把它降级成一个普通 function：

```json
{
  "type": "function",
  "function": {
    "name": "web_search",
    "description": "Search the web",
    "parameters": {
      "type": "object",
      "properties": {
        "query": {
          "type": "string"
        }
      },
      "required": ["query"]
    }
  }
}
```

也就是说：

```text
Anthropic Server Tool
web_search
        ↓
你的兼容层
        ↓
Chat Function Tool
web_search
```

注意这个 Chat function 是：

```text
你的内部实现细节。
```

它绝对不能直接返回给 Claude Code。

---

# 10. 第二次 `/messages` → 第一次内部 `/chat/completions`

你发给上游：

```http
POST /v1/chat/completions
```

```json
{
  "model": "your-upstream-model",
  "messages": [
    {
      "role": "system",
      "content": "You are an assistant for performing a web search."
    },
    {
      "role": "user",
      "content": "Perform a web search for the query: OpenAI latest updates 2026"
    }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "web_search",
        "description": "Search the web",
        "parameters": {
          "type": "object",
          "properties": {
            "query": {
              "type": "string"
            }
          },
          "required": ["query"]
        }
      }
    }
  ],
  "tool_choice": {
    "type": "function",
    "function": {
      "name": "web_search"
    }
  }
}
```

这里非常关键：

```text
你不需要自己从：

"Perform a web search for the query: ..."

parse query。
```

因为你可以让 Chat 模型自己产生 function arguments。

---

# 11. Chat 上游生成真正的搜索 query

上游返回：

```json
{
  "id": "chatcmpl-side-001",
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": null,
        "tool_calls": [
          {
            "id": "call_internal_search_001",
            "type": "function",
            "function": {
              "name": "web_search",
              "arguments": "{\"query\":\"OpenAI latest updates 2026\"}"
            }
          }
        ]
      },
      "finish_reason": "tool_calls"
    }
  ]
}
```

这里：

```json
{
  "query": "OpenAI latest updates 2026"
}
```

才是：

```text
真正应该交给搜索引擎的 query。
```

完整路径：

```text
外层主模型
WebSearch.input.query
        ↓
Claude Code
        ↓
side request messages
        ↓
上游 Chat 模型
        ↓
web_search function arguments
        ↓
你的搜索实现
```

---

# 12. 你的兼容层执行真正搜索

现在你的兼容层拿到：

```json
{
  "query": "OpenAI latest updates 2026"
}
```

执行真正的 search：

```text
search("OpenAI latest updates 2026")
```

例如得到：

```json
[
  {
    "title": "OpenAI announces ...",
    "url": "https://example.com/1",
    "snippet": "..."
  },
  {
    "title": "OpenAI API update ...",
    "url": "https://example.com/2",
    "snippet": "..."
  }
]
```

这一步：

```text
✅ 发生在你的兼容层
```

因为上游只是普通 Chat API。

---

# 13. 把 search result 回传给 Chat 上游

现在需要完成普通 Chat function-call loop。

再次调用：

```http
POST /v1/chat/completions
```

messages：

```json
{
  "model": "your-upstream-model",
  "messages": [
    {
      "role": "system",
      "content": "You are an assistant for performing a web search."
    },
    {
      "role": "user",
      "content": "Perform a web search for the query: OpenAI latest updates 2026"
    },
    {
      "role": "assistant",
      "content": null,
      "tool_calls": [
        {
          "id": "call_internal_search_001",
          "type": "function",
          "function": {
            "name": "web_search",
            "arguments": "{\"query\":\"OpenAI latest updates 2026\"}"
          }
        }
      ]
    },
    {
      "role": "tool",
      "tool_call_id": "call_internal_search_001",
      "content": "[{\"title\":\"OpenAI announces ...\",\"url\":\"https://example.com/1\",\"snippet\":\"...\"},{\"title\":\"OpenAI API update ...\",\"url\":\"https://example.com/2\",\"snippet\":\"...\"}]"
    }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "web_search",
        "parameters": {
          "type": "object",
          "properties": {
            "query": {
              "type": "string"
            }
          },
          "required": ["query"]
        }
      }
    }
  ]
}
```

---

# 14. 上游模型基于搜索结果回答

现在上游看到：

```text
用户要求搜索 Q

+

自己调用过 web_search(Q)

+

tool result 里有真实搜索结果
```

于是返回：

```json
{
  "id": "chatcmpl-side-002",
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "根据搜索结果，OpenAI 最近发布了……"
      },
      "finish_reason": "stop"
    }
  ]
}
```

这就是：

```text
基于 Web Search 的模型回答
```

---

# 15. 如果上游再次调用 `web_search`

不能假设只有一次。

例如第二轮可能返回：

```json
{
  "tool_calls": [
    {
      "id": "call_internal_search_002",
      "type": "function",
      "function": {
        "name": "web_search",
        "arguments": "{\"query\":\"OpenAI September 2026 API announcements\"}"
      }
    }
  ]
}
```

那你的兼容层再次：

```text
执行搜索
↓
追加 tool result
↓
再次请求 Chat
```

所以内部需要：

```text
while model requests web_search:
    execute search
    append tool result
    call chat again
```

并且应该尊重 Anthropic side request 里的：

```json
{
  "max_uses": 8
}
```

例如：

```text
最多允许 8 次内部搜索
```

---

# 16. 这整个过程对 Claude Code 是隐藏的

第二次 `/messages` 请求期间：

```text
Claude Code
       │
       │ POST /messages
       ▼
你的兼容层

   Chat call #1
       ↓
 web_search function_call
       ↓
 你真正搜索
       ↓
   Chat call #2
       ↓
 如果还有搜索
       ↓
 再搜索 / 再 Chat
       ↓
 最终 text

       │
       ▼
Claude Code
```

Claude Code 不会看到：

```text
Chat function_call
```

也不会看到：

```text
你的搜索 provider
```

因为从 Claude Code 看：

```text
web_search 是 server tool。
```

所以 server-side loop 应该完全在你的 `/messages` 请求内部完成。

---

# 17. 第二次 `/messages` 最终回包

假设最终上游返回：

```text
根据搜索结果，OpenAI 最近……
```

最简单的兼容方式可以返回：

```json
{
  "id": "msg_side_final",
  "type": "message",
  "role": "assistant",
  "content": [
    {
      "type": "text",
      "text": "根据搜索结果，OpenAI 最近……"
    }
  ],
  "stop_reason": "end_turn"
}
```

Claude Code 收到。

---

# 18. Claude Code 完成外层 `WebSearch`

还记得最开始那个：

```json
{
  "type": "tool_use",
  "id": "toolu_search_001",
  "name": "WebSearch",
  "input": {
    "query": "OpenAI latest updates 2026"
  }
}
```

吗？

Claude Code 现在拿到了第二次 side request 的结果：

```text
根据搜索结果，OpenAI 最近……
```

于是把它当成大写 `WebSearch` 的：

```text
tool_result
```

接着第三次调用你的 `/messages`。

---

# 19. Claude Code 回到主 Agent

例如：

```http
POST /v1/messages
```

```json
{
  "model": "claude-opus-...",
  "messages": [
    {
      "role": "user",
      "content": "帮我查一下 OpenAI 最近有什么更新"
    },
    {
      "role": "assistant",
      "content": [
        {
          "type": "tool_use",
          "id": "toolu_search_001",
          "name": "WebSearch",
          "input": {
            "query": "OpenAI latest updates 2026"
          }
        }
      ]
    },
    {
      "role": "user",
      "content": [
        {
          "type": "tool_result",
          "tool_use_id": "toolu_search_001",
          "content": "根据搜索结果，OpenAI 最近……"
        }
      ]
    }
  ],
  "tools": [
    {
      "name": "WebSearch",
      "input_schema": {
        "...": "..."
      }
    },
    {
      "name": "Read",
      "input_schema": {
        "...": "..."
      }
    }
  ]
}
```

注意：

```text
现在又回到了大写 WebSearch。
```

因为这是主 Agent 的 client-tool history。

---

# 20. 主 Agent continuation → Chat

你的兼容层把它转换为 Chat：

```json
{
  "model": "your-upstream-model",
  "messages": [
    {
      "role": "user",
      "content": "帮我查一下 OpenAI 最近有什么更新"
    },
    {
      "role": "assistant",
      "content": null,
      "tool_calls": [
        {
          "id": "call_search_001",
          "type": "function",
          "function": {
            "name": "WebSearch",
            "arguments": "{\"query\":\"OpenAI latest updates 2026\"}"
          }
        }
      ]
    },
    {
      "role": "tool",
      "tool_call_id": "call_search_001",
      "content": "根据搜索结果，OpenAI 最近……"
    }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "WebSearch",
        "parameters": {
          "...": "..."
        }
      }
    }
  ]
}
```

---

# 21. 上游主模型最终回答

Chat 返回：

```json
{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "OpenAI 最近主要有这些更新：……"
      },
      "finish_reason": "stop"
    }
  ]
}
```

你的兼容层转换：

```json
{
  "id": "msg_final",
  "type": "message",
  "role": "assistant",
  "content": [
    {
      "type": "text",
      "text": "OpenAI 最近主要有这些更新：……"
    }
  ],
  "stop_reason": "end_turn"
}
```

返回 Claude Code。

至此整个 WebSearch 完成。

---

# 22. 完整时序图

```text
Claude Code                  你的 /messages                 上游 Chat
    │                              │                            │
    │ ① 主请求                     │                            │
    │ tools=[WebSearch,...]        │                            │
    ├─────────────────────────────>│                            │
    │                              │                            │
    │                              │ ② 转普通 function          │
    │                              │ WebSearch                  │
    │                              ├───────────────────────────>│
    │                              │                            │
    │                              │     tool_call WebSearch(Q) │
    │                              │<───────────────────────────┤
    │                              │                            │
    │ ③ tool_use WebSearch(Q)      │                            │
    │<─────────────────────────────┤                            │
    │                              │                            │
    │                              │                            │
    │ CC 执行 WebSearch            │                            │
    │                              │                            │
    │ ④ side request               │                            │
    │ tools=[web_search_...]       │                            │
    ├─────────────────────────────>│                            │
    │                              │                            │
    │                              │ ⑤ 转内部 function           │
    │                              │ web_search                 │
    │                              ├───────────────────────────>│
    │                              │                            │
    │                              │ tool_call web_search(Q2)   │
    │                              │<───────────────────────────┤
    │                              │                            │
    │                              │                            │
    │                       ┌──────┴──────┐                     │
    │                       │ 真正执行搜索 │                     │
    │                       └──────┬──────┘                     │
    │                              │                            │
    │                              │ ⑥ tool result              │
    │                              ├───────────────────────────>│
    │                              │                            │
    │                              │ 基于搜索结果的 text         │
    │                              │<───────────────────────────┤
    │                              │                            │
    │ ⑦ side request 最终回答      │                            │
    │<─────────────────────────────┤                            │
    │                              │                            │
    │ CC 将它包装成                │                            │
    │ WebSearch tool_result        │                            │
    │                              │                            │
    │ ⑧ 主 Agent continuation      │                            │
    ├─────────────────────────────>│                            │
    │                              │                            │
    │                              │ ⑨ function result          │
    │                              ├───────────────────────────>│
    │                              │                            │
    │                              │ 最终主回答                  │
    │                              │<───────────────────────────┤
    │                              │                            │
    │ ⑩ 最终回答                   │                            │
    │<─────────────────────────────┤                            │
```

---

# 23. 最重要的两条分支

你的 `/messages` handler 应该明确区分：

## A. 大写 `WebSearch`

```json
{
  "name": "WebSearch",
  "input_schema": {}
}
```

处理方式：

```text
→ 普通 client tool
→ 转成 Chat function
→ 上游调用后
→ 转成 Anthropic tool_use
→ 返回 Claude Code
→ 绝对不要自己执行搜索
```

---

## B. 小写 `web_search_*`

```json
{
  "type": "web_search_20250305",
  "name": "web_search"
}
```

处理方式：

```text
→ Anthropic server tool
→ 不应该把 tool call 暴露给 Claude Code
→ 转成你内部的 Chat function
→ Chat 生成 query
→ 你的兼容层执行搜索
→ tool result 回 Chat
→ Chat 继续生成
→ 整个内部 loop 完成后
→ 才返回这次 /messages 请求
```

---

# 24. 核心代码逻辑

整体可以理解为：

```go
func HandleMessages(req AnthropicRequest) AnthropicResponse {
    if hasServerWebSearch(req.Tools) {
        return handleServerWebSearch(req)
    }

    return handleNormalClaudeCodeRequest(req)
}
```

普通主 Agent：

```go
func handleNormalClaudeCodeRequest(
    req AnthropicRequest,
) AnthropicResponse {

    chatReq := convertAnthropicToChat(req)

    chatResp := callUpstreamChat(chatReq)

    // 如果 Chat 调用的是 WebSearch / Read / Bash 等
    // 不执行。
    // 直接转换成 Anthropic tool_use 返回 CC。

    return convertChatToAnthropic(chatResp)
}
```

Server WebSearch：

```go
func handleServerWebSearch(
    req AnthropicRequest,
) AnthropicResponse {

    chatReq := convertServerWebSearchToChat(req)

    searchCount := 0
    maxUses := getMaxUses(req) // 例如 8

    for {
        chatResp := callUpstreamChat(chatReq)

        call := findToolCall(chatResp, "web_search")

        if call == nil {
            // 模型已经生成最终答案
            return convertFinalChatToAnthropic(chatResp)
        }

        if searchCount >= maxUses {
            return errorOrForceFinish()
        }

        query := call.Arguments.Query

        result := executeWebSearch(query)

        chatReq.Messages = append(
            chatReq.Messages,
            chatResp.AssistantMessage,
            ChatMessage{
                Role:       "tool",
                ToolCallID: call.ID,
                Content:    serialize(result),
            },
        )

        searchCount++
    }
}
```

---

# 25. 最终关系

可以压缩成一句话：

```text
Claude Code 大写 WebSearch
        ↓
你的 API 当普通 function 转给 Chat
        ↓
Chat 返回 WebSearch tool call
        ↓
你的 API 返回给 Claude Code
        ↓
Claude Code 执行 WebSearch
        ↓
Claude Code 再调用你的 /messages，
这一次带小写 web_search server tool
        ↓
你的 API 把它变成内部 Chat function
        ↓
Chat 产生真正 query
        ↓
你的 API 真正搜索
        ↓
search result → Chat
        ↓
Chat 生成基于搜索结果的回答
        ↓
你的 API 返回 Claude Code
        ↓
Claude Code 包装成外层 WebSearch tool_result
        ↓
主 Agent 继续
```

---

# 26. 一定不要做错的地方

错误：

```text
主请求看到：

WebSearch

↓

你的服务直接搜索
```

因为这样 Claude Code 永远收不到：

```text
tool_use WebSearch
```

会破坏 CC 的 client-tool lifecycle。

正确：

```text
主请求 WebSearch
↓
返回 CC 执行

side request web_search_*
↓
你的服务内部执行
```

另外也不要：

```text
收到 web_search_* 后
直接从 user prompt 正则提取 query
然后搜索
```

更接近 Anthropic server-tool 语义的是：

```text
messages
+
web_search function schema
↓
Chat 模型生成结构化 query
↓
你的服务执行搜索
```

因此模型仍然负责：

```text
tool selection / query generation
```

而你的兼容层负责：

```text
tool execution / continuation loop
```

这就是普通 Chat 上游情况下最干净的实现。
