#!/usr/bin/env node

import http from 'node:http';

const port = Number(process.env.MOCK_UPSTREAM_PORT || '3100');

const sendJson = (response, status, payload) => {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(payload));
};

const sendSse = (response, events) => {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    Connection: 'keep-alive',
    'Cache-Control': 'no-cache, no-transform',
  });

  for (const { event, data } of events) {
    response.write(`event: ${event}\n`);
    response.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  response.end();
};

const readBody = async (request) => {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
};

const buildResponseEvents = (body) => {
  const responseId = 'resp_mock_123';
  const messageItem = {
    id: 'msg_mock_1',
    type: 'message',
    role: 'assistant',
    content: [
      {
        type: 'output_text',
        text:
          typeof body.previous_response_id === 'string'
            ? 'This is turn two.'
            : 'Hello from mock upstream.',
      },
    ],
  };

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const functionItem = {
      id: 'fc_mock_1',
      type: 'function_call',
      name: 'hello',
      call_id: 'call_mock_1',
      arguments: '{"name":"Codex"}',
    };

    return [
      {
        event: 'response.created',
        data: {
          response: {
            id: responseId,
            status: 'in_progress',
            output: [],
          },
        },
      },
      {
        event: 'response.in_progress',
        data: {
          response: {
            id: responseId,
            status: 'in_progress',
            output: [],
          },
        },
      },
      {
        event: 'response.output_item.added',
        data: {
          output_index: 0,
          item: functionItem,
        },
      },
      {
        event: 'response.function_call_arguments.delta',
        data: {
          output_index: 0,
          item_id: functionItem.id,
          delta: '{"name":"Co',
        },
      },
      {
        event: 'response.function_call_arguments.delta',
        data: {
          output_index: 0,
          item_id: functionItem.id,
          delta: 'dex"}',
        },
      },
      {
        event: 'response.function_call_arguments.done',
        data: {
          output_index: 0,
          item_id: functionItem.id,
          arguments: functionItem.arguments,
        },
      },
      {
        event: 'response.output_item.done',
        data: {
          output_index: 0,
          item: functionItem,
        },
      },
      {
        event: 'response.completed',
        data: {
          response: {
            id: responseId,
            status: 'completed',
            output: [functionItem],
          },
        },
      },
    ];
  }

  return [
    {
      event: 'response.created',
      data: {
        response: {
          id: responseId,
          status: 'in_progress',
          output: [],
        },
      },
    },
    {
      event: 'response.in_progress',
      data: {
        response: {
          id: responseId,
          status: 'in_progress',
          output: [],
        },
      },
    },
    {
      event: 'response.output_item.added',
      data: {
        output_index: 0,
        item: messageItem,
      },
    },
    {
      event: 'response.output_text.delta',
      data: {
        output_index: 0,
        item: messageItem,
        delta: 'Hello ',
      },
    },
    {
      event: 'response.output_text.delta',
      data: {
        output_index: 0,
        item: messageItem,
        delta:
          typeof body.previous_response_id === 'string'
            ? 'This is turn two.'
            : 'from mock upstream.',
      },
    },
    {
      event: 'response.output_text.done',
      data: {
        output_index: 0,
        item: messageItem,
        text: messageItem.content[0].text,
      },
    },
    {
      event: 'response.output_item.done',
      data: {
        output_index: 0,
        item: messageItem,
      },
    },
    {
      event: 'response.completed',
      data: {
        response: {
          id: responseId,
          status: 'completed',
          output: [messageItem],
        },
      },
    },
  ];
};

const buildChatCompletionsSse = (body) => {
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;

  if (hasTools) {
    return (
      [
        'data: {"id":"chatcmpl_mock","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
        'data: {"id":"chatcmpl_mock","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_mock_1","type":"function","function":{"name":"hello","arguments":"{\\"name\\":\\"Codex\\"}"}}]},"finish_reason":null}]}',
        'data: {"id":"chatcmpl_mock","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
        'data: [DONE]',
      ].join('\n\n') + '\n\n'
    );
  }

  return (
    [
      'data: {"id":"chatcmpl_mock","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
      'data: {"id":"chatcmpl_mock","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello from Claude-compatible mock."},"finish_reason":null}]}',
      'data: {"id":"chatcmpl_mock","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      'data: [DONE]',
    ].join('\n\n') + '\n\n'
  );
};

const server = http.createServer(async (request, response) => {
  const body = request.method === 'POST' ? await readBody(request) : {};

  if (request.url === '/v1/responses' && request.method === 'POST') {
    return sendSse(response, buildResponseEvents(body));
  }

  if (request.url === '/v2/chat/completions' && request.method === 'POST') {
    if (body.stream) {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        Connection: 'keep-alive',
        'Cache-Control': 'no-cache, no-transform',
      });
      response.end(buildChatCompletionsSse(body));
      return;
    }

    if (Array.isArray(body.tools) && body.tools.length > 0) {
      return sendJson(response, 200, {
        id: 'chatcmpl_mock',
        object: 'chat.completion',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              tool_calls: [
                {
                  id: 'call_mock_1',
                  type: 'function',
                  function: {
                    name: 'hello',
                    arguments: '{"name":"Codex"}',
                  },
                },
              ],
              content: null,
            },
            finish_reason: 'tool_calls',
          },
        ],
      });
    }

    return sendJson(response, 200, {
      id: 'chatcmpl_mock',
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'Hello from Claude-compatible mock.',
          },
          finish_reason: 'stop',
        },
      ],
    });
  }

  sendJson(response, 404, { error: 'not found' });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`mock upstream listening on http://127.0.0.1:${port}`);
});
