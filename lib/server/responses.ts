import type { NextRequest } from 'next/server';

import { getAvailableModels } from './config';
import { createErrorResponse } from './http';
import { proxyChatCompletions } from './codebuddy';

interface ResponsesInputItem {
  type?: string;
  role?: string;
  content?: unknown;
  text?: string;
  arguments?: string;
  output?: unknown;
  name?: string;
  call_id?: string;
}

interface ResponsesRequestBody {
  model?: string;
  input?: string | ResponsesInputItem[];
  instructions?: string;
  messages?: Array<{ role?: string; content?: unknown }>;
  stream?: boolean;
  metadata?: Record<string, unknown>;
  reasoning?: Record<string, unknown>;
  thinking?: Record<string, unknown>;
  tools?: Array<{ type?: string; name?: string } & Record<string, unknown>>;
  tool_choice?: unknown;
  max_output_tokens?: number;
  previous_response_id?: string;
}

type ResponseSessionDefaults = Pick<
  ResponsesRequestBody,
  'instructions' | 'metadata' | 'tools' | 'tool_choice'
>;

interface ResponseSession {
  id: string;
  model: string;
  transcript: TranscriptMessage[];
  defaults: ResponseSessionDefaults;
}

interface ChatResponseToolCall {
  index?: number;
  id?: string;
  type?: string;
  function?: {
    arguments?: string;
    name?: string;
  };
}

interface ChatResponseMessage {
  content?: unknown;
  tool_calls?: ChatResponseToolCall[];
}

interface TranscriptMessage {
  role: string;
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
}

interface StreamingToolCallState {
  addedEmitted: boolean;
  arguments: string;
  canonicalKey: string;
  callId: string;
  name: string;
  outputIndex: number;
  outputItemId: string;
  pendingArgumentDeltas: string[];
}

type SupportedResponsesTool = NonNullable<
  ResponsesRequestBody['tools']
>[number];

const globalResponsesState = globalThis as typeof globalThis & {
  __codebuddy2apiResponseSessions__?: Map<string, ResponseSession>;
};

const getSessionStore = (): Map<string, ResponseSession> => {
  if (!globalResponsesState.__codebuddy2apiResponseSessions__) {
    globalResponsesState.__codebuddy2apiResponseSessions__ = new Map();
  }

  return globalResponsesState.__codebuddy2apiResponseSessions__;
};

const extractFunctionDefinition = (
  tool: Record<string, unknown>,
): Record<string, unknown> | null => {
  const nested =
    typeof tool.function === 'object' && tool.function !== null
      ? (tool.function as Record<string, unknown>)
      : {};

  const name = nested.name ?? tool.name;
  if (typeof name !== 'string' || name.length === 0) {
    return null;
  }

  const functionDef: Record<string, unknown> = { name };

  const description = nested.description ?? tool.description;
  if (description !== undefined) {
    functionDef.description = description;
  }

  const parameters = nested.parameters ?? tool.parameters;
  if (parameters !== undefined) {
    functionDef.parameters = parameters;
  }

  const strict = nested.strict ?? tool.strict;
  if (strict !== undefined) {
    functionDef.strict = strict;
  }

  return functionDef;
};

const filterSupportedTools = (
  tools: ResponsesRequestBody['tools'],
): NonNullable<ResponsesRequestBody['tools']> => {
  if (!tools?.length) {
    return [];
  }

  return tools.filter((tool) => extractFunctionDefinition(tool) !== null);
};

const findSupportedToolByName = (
  tools: ResponsesRequestBody['tools'],
  name: string,
): SupportedResponsesTool | null => {
  if (!tools?.length || !name) {
    return null;
  }

  return (
    filterSupportedTools(tools).find(
      (tool) => extractFunctionDefinition(tool)?.name === name,
    ) ?? null
  );
};

const hasSupportedLongerToolNamePrefix = (
  tools: ResponsesRequestBody['tools'],
  prefix: string,
): boolean => {
  if (!tools?.length || !prefix) {
    return false;
  }

  return filterSupportedTools(tools).some((tool) => {
    const name = extractFunctionDefinition(tool)?.name;
    return (
      typeof name === 'string' &&
      name.length > prefix.length &&
      name.startsWith(prefix)
    );
  });
};

const buildResponsesToolCallOutputItem = (
  tools: ResponsesRequestBody['tools'],
  toolCall: {
    arguments: string;
    callId: string;
    id: string;
    name: string;
    status: 'completed' | 'in_progress';
  },
): Record<string, unknown> => {
  const originalTool = findSupportedToolByName(tools, toolCall.name);
  const itemType = originalTool?.type === 'mcp' ? 'mcp_call' : 'function_call';
  const item: Record<string, unknown> = {
    id: toolCall.id,
    type: itemType,
    call_id: toolCall.callId,
    name: toolCall.name || 'function',
    arguments: toolCall.arguments,
    status: toolCall.status,
  };

  if (
    originalTool?.type === 'mcp' &&
    typeof originalTool.server_label === 'string'
  ) {
    item.server_label = originalTool.server_label;
  }

  return item;
};

const getResponsesToolCallArgumentDeltaEventType = (
  tools: ResponsesRequestBody['tools'],
  name: string,
):
  | 'response.function_call_arguments.delta'
  | 'response.mcp_call_arguments.delta' => {
  return findSupportedToolByName(tools, name)?.type === 'mcp'
    ? 'response.mcp_call_arguments.delta'
    : 'response.function_call_arguments.delta';
};

const buildAssistantTranscriptToolCalls = (
  toolCalls: ChatResponseToolCall[],
): TranscriptMessage['tool_calls'] | undefined => {
  if (!toolCalls.length) {
    return undefined;
  }

  return toolCalls.map((toolCall, index) => ({
    id: normalizeToolCallId(toolCall.id, index),
    type: 'function',
    function: {
      name: toolCall.function?.name ?? 'function',
      arguments: toolCall.function?.arguments ?? '',
    },
  }));
};

const buildStreamingAssistantTranscriptToolCalls = (
  toolCallStates: StreamingToolCallState[],
): TranscriptMessage['tool_calls'] | undefined => {
  if (!toolCallStates.length) {
    return undefined;
  }

  return toolCallStates.map((toolCallState) => ({
    id: toolCallState.callId,
    type: 'function',
    function: {
      arguments: toolCallState.arguments,
      name: toolCallState.name,
    },
  }));
};

const getAssistantTranscriptContent = (
  outputText: string,
  toolCalls: TranscriptMessage['tool_calls'] | undefined,
): string | null => {
  return toolCalls?.length ? outputText || null : outputText;
};

const stringifyContent = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }

        if (item && typeof item === 'object' && 'text' in item) {
          return String((item as { text?: unknown }).text ?? '');
        }

        return JSON.stringify(item);
      })
      .join('');
  }

  if (value === undefined || value === null) {
    return '';
  }

  return JSON.stringify(value);
};

const mapInputItemToMessage = (item: ResponsesInputItem): TranscriptMessage => {
  if (item.type === 'function_call' || item.type === 'mcp_call') {
    return {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: item.call_id ?? createResponseOutputId(),
          type: 'function',
          function: {
            name: item.name ?? 'function',
            arguments: item.arguments ?? '',
          },
        },
      ],
    };
  }

  if (item.type === 'function_call_output' || item.type === 'mcp_call_output') {
    if (item.call_id) {
      return {
        role: 'tool',
        content: stringifyContent(item.output),
        tool_call_id: item.call_id,
      };
    }

    return {
      role: 'user',
      content: stringifyContent(item.output),
    };
  }

  if (item.type === 'mcp_approval_response') {
    return {
      role: 'user',
      content: JSON.stringify(item),
    };
  }

  return {
    role: item.role ?? 'user',
    content: item.text ?? stringifyContent(item.content),
  };
};

const createResponseId = (): string => {
  return `resp_${crypto.randomUUID().replaceAll('-', '')}`;
};

const createMessageId = (): string => {
  return `msg_${crypto.randomUUID().replaceAll('-', '')}`;
};

const createResponseOutputId = (): string => {
  return `fc_${crypto.randomUUID().replaceAll('-', '')}`;
};

const normalizeToolCallId = (id: string | undefined, index: number): string => {
  if (id && !id.startsWith('tooluse_')) {
    return id;
  }

  return `call_${id?.replace(/^tooluse_/, '') ?? index + 1}`;
};

export const translateResponsesToolsToChat = (
  tools: ResponsesRequestBody['tools'],
): unknown[] | undefined => {
  if (!tools?.length) {
    return undefined;
  }

  const supported = filterSupportedTools(tools);
  if (!supported.length) {
    return undefined;
  }

  return supported.map((tool) => {
    const functionDef = extractFunctionDefinition(tool) as Record<
      string,
      unknown
    >;
    return {
      type: 'function',
      function: functionDef,
    };
  });
};

const translateResponsesToolChoiceToChat = (toolChoice: unknown): unknown => {
  if (typeof toolChoice !== 'object' || toolChoice === null) {
    return toolChoice;
  }

  const choice = toolChoice as Record<string, unknown>;

  if (
    choice.type === 'function' &&
    choice.function &&
    typeof choice.function === 'object'
  ) {
    return toolChoice;
  }

  if (
    (choice.type === 'auto' ||
      choice.type === 'none' ||
      choice.type === 'required') &&
    typeof choice.type === 'string'
  ) {
    return choice.type;
  }

  // Responses API selects a function by name:
  // {type: 'function', name: 'fn'} -> chat schema {type: 'function', function: {name: 'fn'}}
  if (typeof choice.name === 'string') {
    return {
      type: 'function',
      function: { name: choice.name },
    };
  }

  return toolChoice;
};

const getNamedToolChoice = (toolChoice: unknown): string | null => {
  if (typeof toolChoice !== 'object' || toolChoice === null) {
    return null;
  }

  const choice = toolChoice as Record<string, unknown>;

  if (typeof choice.name === 'string' && choice.name.length > 0) {
    return choice.name;
  }

  if (
    choice.type === 'function' &&
    typeof choice.function === 'object' &&
    choice.function !== null &&
    typeof (choice.function as Record<string, unknown>).name === 'string'
  ) {
    return (choice.function as Record<string, string>).name;
  }

  return null;
};

const getResponsesCompatibilityError = (
  tools: ResponsesRequestBody['tools'],
  toolChoice: unknown,
): Response | null => {
  const supportedTools = filterSupportedTools(tools);

  if (toolChoice === 'required' && supportedTools.length === 0) {
    return createErrorResponse(
      400,
      'tool_choice=required requires at least one supported tool for this /v1/responses adapter',
    );
  }

  if (typeof toolChoice === 'object' && toolChoice !== null) {
    const choice = toolChoice as Record<string, unknown>;
    const isPretranslatedFunctionChoice =
      choice.type === 'function' &&
      typeof choice.function === 'object' &&
      choice.function !== null;
    const isSimpleChoiceType =
      choice.type === 'auto' ||
      choice.type === 'none' ||
      choice.type === 'required';
    const isNamedFunctionLikeChoice = typeof choice.name === 'string';

    if (
      !isPretranslatedFunctionChoice &&
      !isSimpleChoiceType &&
      !isNamedFunctionLikeChoice
    ) {
      return createErrorResponse(
        400,
        'Unsupported Responses tool_choice for this /v1/responses adapter',
      );
    }

    if (choice.type === 'required' && supportedTools.length === 0) {
      return createErrorResponse(
        400,
        'tool_choice=required requires at least one supported tool for this /v1/responses adapter',
      );
    }
  }

  const namedToolChoice = getNamedToolChoice(toolChoice);
  if (namedToolChoice) {
    const supportedNames = new Set(
      supportedTools
        .map((tool) => extractFunctionDefinition(tool)?.name)
        .filter((name): name is string => typeof name === 'string'),
    );

    if (!supportedNames.has(namedToolChoice)) {
      return createErrorResponse(
        400,
        'tool_choice references a tool that is not available to this /v1/responses adapter',
      );
    }
  }

  return null;
};

const getStreamingToolCallCanonicalKey = (
  toolCall: ChatResponseToolCall,
  position: number,
): string => {
  if (toolCall.id) {
    return `id:${toolCall.id}`;
  }

  if (typeof toolCall.index === 'number') {
    return `index:${toolCall.index}`;
  }

  return `position:${position}`;
};

const getStreamingToolCallLookupKeys = (
  toolCall: ChatResponseToolCall,
  position: number,
): string[] => {
  if (toolCall.id || typeof toolCall.index === 'number') {
    return [
      toolCall.id ? `id:${toolCall.id}` : null,
      typeof toolCall.index === 'number' ? `index:${toolCall.index}` : null,
    ].filter((key): key is string => key !== null);
  }

  return [`position:${position}`];
};

const prepareTranscript = (
  body: ResponsesRequestBody,
): {
  defaults: ResponseSessionDefaults;
  model: string;
  transcript: TranscriptMessage[];
  previousResponseId: string | null;
} => {
  const previousResponseId = body.previous_response_id ?? null;
  const previousSession = previousResponseId
    ? getSessionStore().get(previousResponseId)
    : undefined;

  if (previousResponseId && !previousSession) {
    throw new Error('Unknown or expired previous_response_id');
  }

  const transcript = [...(previousSession?.transcript ?? [])];
  const model =
    body.model ??
    previousSession?.model ??
    getAvailableModels()[0] ??
    'glm-5.1';
  const defaults = {
    instructions:
      body.instructions ?? previousSession?.defaults.instructions ?? undefined,
    metadata: body.metadata ?? previousSession?.defaults.metadata ?? undefined,
    tools: body.tools ?? previousSession?.defaults.tools ?? undefined,
    tool_choice:
      body.tool_choice ?? previousSession?.defaults.tool_choice ?? undefined,
  };

  if (body.messages?.length) {
    body.messages.forEach((item) => {
      transcript.push({
        role: item.role ?? 'user',
        content: stringifyContent(item.content),
      });
    });
  } else if (typeof body.input === 'string') {
    transcript.push({ role: 'user', content: body.input });
  } else if (Array.isArray(body.input)) {
    body.input.forEach((item) => {
      transcript.push(mapInputItemToMessage(item));
    });
  }

  return {
    defaults,
    model,
    transcript,
    previousResponseId,
  };
};

const mapChatResponseToResponsesPayload = (
  defaults: ResponseSessionDefaults,
  transcript: TranscriptMessage[],
  model: string,
  previousResponseId: string | null,
  upstreamPayload: Record<string, unknown>,
): Record<string, unknown> => {
  const responseId = createResponseId();
  const choices = Array.isArray(upstreamPayload.choices)
    ? upstreamPayload.choices
    : [];
  const firstChoice = (choices[0] ?? {}) as {
    message?: ChatResponseMessage;
  };
  const toolCalls = Array.isArray(firstChoice.message?.tool_calls)
    ? firstChoice.message.tool_calls
    : [];
  const outputText = stringifyContent(firstChoice.message?.content);
  const createdAt = Math.floor(Date.now() / 1000);
  const output: Array<Record<string, unknown>> = [];
  const transcriptToolCalls = buildAssistantTranscriptToolCalls(toolCalls);

  if (outputText || !toolCalls.length) {
    output.push({
      id: createMessageId(),
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [
        {
          type: 'output_text',
          text: outputText,
          annotations: [],
        },
      ],
    });
  }

  toolCalls.forEach((toolCall, index) => {
    output.push(
      buildResponsesToolCallOutputItem(defaults.tools, {
        arguments: toolCall.function?.arguments ?? '',
        callId: normalizeToolCallId(toolCall.id, index),
        id: createResponseOutputId(),
        name: toolCall.function?.name ?? 'function',
        status: 'completed',
      }),
    );
  });

  getSessionStore().set(responseId, {
    id: responseId,
    model,
    transcript: [
      ...transcript,
      {
        role: 'assistant',
        content: getAssistantTranscriptContent(outputText, transcriptToolCalls),
        ...(transcriptToolCalls ? { tool_calls: transcriptToolCalls } : {}),
      },
    ],
    defaults,
  });

  return {
    id: responseId,
    object: 'response',
    created_at: createdAt,
    status: 'completed',
    model,
    output,
    output_text: outputText,
    usage: upstreamPayload.usage ?? null,
    metadata: defaults.metadata ?? {},
    previous_response_id: previousResponseId,
  };
};

const createResponsesEventStream = async (
  request: NextRequest,
  defaults: ResponseSessionDefaults,
  transcript: TranscriptMessage[],
  model: string,
  previousResponseId: string | null,
  maxOutputTokens?: number,
): Promise<Response> => {
  const upstreamResponse = await proxyChatCompletions(request, {
    model,
    messages: [
      ...(defaults.instructions
        ? [{ role: 'system', content: defaults.instructions }]
        : []),
      ...transcript,
    ],
    max_tokens: maxOutputTokens,
    stream: true,
    tools: translateResponsesToolsToChat(defaults.tools),
    tool_choice: translateResponsesToolChoiceToChat(defaults.tool_choice),
  });

  if (!upstreamResponse.ok || !upstreamResponse.body) {
    return upstreamResponse;
  }

  const responseId = createResponseId();
  let outputText = '';
  const toolCallStates = new Map<string, StreamingToolCallState>();
  const toolCallStateKeys = new Map<string, string>();
  let nextToolCallOutputIndex = 0;

  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const reader = upstreamResponse.body!.getReader();
      let buffer = '';

      const enqueueEvent = (payload: Record<string, unknown>): void => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
        );
      };

      enqueueEvent({
        type: 'response.created',
        response: {
          id: responseId,
          object: 'response',
          created_at: Math.floor(Date.now() / 1000),
          model,
        },
      });
      enqueueEvent({
        type: 'response.in_progress',
        response: {
          id: responseId,
          status: 'in_progress',
        },
      });

      const maybeEmitToolCallAdded = (
        toolCallState: StreamingToolCallState,
        allowIncompleteName = false,
      ): void => {
        if (toolCallState.addedEmitted) {
          return;
        }

        const shouldWaitForInitialName =
          !allowIncompleteName &&
          Boolean(defaults.tools?.length) &&
          toolCallState.name.length === 0;
        const shouldWaitForMoreName =
          !allowIncompleteName &&
          defaults.tools?.length &&
          toolCallState.name.length > 0 &&
          hasSupportedLongerToolNamePrefix(defaults.tools, toolCallState.name);

        if (shouldWaitForInitialName || shouldWaitForMoreName) {
          return;
        }

        enqueueEvent({
          type: 'response.output_item.added',
          item: buildResponsesToolCallOutputItem(defaults.tools, {
            arguments: '',
            callId: toolCallState.callId,
            id: toolCallState.outputItemId,
            name: toolCallState.name || 'function',
            status: 'in_progress',
          }),
          output_index: toolCallState.outputIndex,
          response_id: responseId,
        });

        toolCallState.addedEmitted = true;
        toolCallState.pendingArgumentDeltas.forEach((delta) => {
          enqueueEvent({
            type: getResponsesToolCallArgumentDeltaEventType(
              defaults.tools,
              toolCallState.name,
            ),
            delta,
            item_id: toolCallState.outputItemId,
            output_index: toolCallState.outputIndex,
            response_id: responseId,
          });
        });
        toolCallState.pendingArgumentDeltas = [];
      };

      const pump = async (): Promise<void> => {
        const { done, value } = await reader.read();

        if (done) {
          const transcriptToolCalls =
            buildStreamingAssistantTranscriptToolCalls([
              ...toolCallStates.values(),
            ]);
          getSessionStore().set(responseId, {
            id: responseId,
            model,
            transcript: [
              ...transcript,
              {
                role: 'assistant',
                content: getAssistantTranscriptContent(
                  outputText,
                  transcriptToolCalls,
                ),
                ...(transcriptToolCalls
                  ? { tool_calls: transcriptToolCalls }
                  : {}),
              },
            ],
            defaults,
          });
          [...toolCallStates.values()].forEach((toolCallState) => {
            maybeEmitToolCallAdded(toolCallState, true);
            enqueueEvent({
              type: 'response.output_item.done',
              item: buildResponsesToolCallOutputItem(defaults.tools, {
                arguments: toolCallState.arguments,
                callId: toolCallState.callId,
                id: toolCallState.outputItemId,
                name: toolCallState.name || 'function',
                status: 'completed',
              }),
              output_index: toolCallState.outputIndex,
              response_id: responseId,
            });
          });
          enqueueEvent({
            type: 'response.completed',
            response: {
              id: responseId,
              status: 'completed',
              output_text: outputText,
              previous_response_id: previousResponseId,
            },
          });
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
          return;
        }

        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';

        frames.forEach((frame) => {
          const line = frame
            .split('\n')
            .find((segment) => segment.startsWith('data: '));

          if (!line) {
            return;
          }

          const raw = line.slice(6).trim();

          if (!raw || raw === '[DONE]') {
            return;
          }

          try {
            const payload = JSON.parse(raw) as {
              choices?: Array<{
                delta?: {
                  content?: string;
                  reasoning_content?: string;
                  tool_calls?: ChatResponseToolCall[];
                };
              }>;
            };
            const delta = payload.choices?.[0]?.delta;

            if (delta?.content) {
              outputText += delta.content;
              enqueueEvent({
                type: 'response.output_text.delta',
                delta: delta.content,
                response_id: responseId,
              });
            }

            if (delta?.reasoning_content) {
              enqueueEvent({
                type: 'response.reasoning_text.delta',
                delta: delta.reasoning_content,
                response_id: responseId,
              });
            }

            delta?.tool_calls?.forEach((toolCall, position) => {
              const lookupKeys = getStreamingToolCallLookupKeys(
                toolCall,
                position,
              );
              const existingCanonicalKey = lookupKeys
                .map((key) => toolCallStateKeys.get(key) ?? key)
                .find((key) => toolCallStates.has(key));
              const canonicalKey =
                existingCanonicalKey ??
                getStreamingToolCallCanonicalKey(toolCall, position);
              const current = toolCallStates.get(canonicalKey) ?? {
                addedEmitted: false,
                arguments: '',
                canonicalKey,
                callId: normalizeToolCallId(
                  toolCall.id,
                  nextToolCallOutputIndex,
                ),
                name: '',
                outputIndex: nextToolCallOutputIndex++,
                outputItemId: createResponseOutputId(),
                pendingArgumentDeltas: [],
              };

              if (toolCall.function?.name) {
                current.name += toolCall.function.name;
              }
              maybeEmitToolCallAdded(current);

              if (toolCall.function?.arguments) {
                current.arguments += toolCall.function.arguments;
                if (current.addedEmitted) {
                  enqueueEvent({
                    type: getResponsesToolCallArgumentDeltaEventType(
                      defaults.tools,
                      current.name,
                    ),
                    delta: toolCall.function.arguments,
                    item_id: current.outputItemId,
                    output_index: current.outputIndex,
                    response_id: responseId,
                  });
                } else {
                  current.pendingArgumentDeltas.push(
                    toolCall.function.arguments,
                  );
                }
              }

              toolCallStates.set(canonicalKey, current);
              lookupKeys.forEach((key) => {
                toolCallStateKeys.set(key, current.canonicalKey);
              });
            });
          } catch {
            enqueueEvent({
              type: 'response.error',
              error: {
                message: 'Failed to parse upstream SSE frame',
              },
            });
          }
        });

        await pump();
      };

      void pump();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
    },
  });
};

export const handleResponsesRequest = async (
  request: NextRequest,
  body: ResponsesRequestBody,
): Promise<Response> => {
  try {
    const prepared = prepareTranscript(body);
    const compatibilityError = getResponsesCompatibilityError(
      prepared.defaults.tools,
      prepared.defaults.tool_choice,
    );

    if (compatibilityError) {
      return compatibilityError;
    }

    prepared.defaults.tools = filterSupportedTools(prepared.defaults.tools);

    if (body.stream) {
      return await createResponsesEventStream(
        request,
        prepared.defaults,
        prepared.transcript,
        prepared.model,
        prepared.previousResponseId,
        body.max_output_tokens,
      );
    }

    const upstreamResponse = await proxyChatCompletions(request, {
      model: prepared.model,
      messages: [
        ...(prepared.defaults.instructions
          ? [{ role: 'system', content: prepared.defaults.instructions }]
          : []),
        ...prepared.transcript,
      ],
      max_tokens: body.max_output_tokens,
      stream: false,
      tools: translateResponsesToolsToChat(prepared.defaults.tools),
      tool_choice: translateResponsesToolChoiceToChat(
        prepared.defaults.tool_choice,
      ),
    });

    if (!upstreamResponse.ok) {
      return upstreamResponse;
    }

    const upstreamPayload = (await upstreamResponse.json()) as Record<
      string,
      unknown
    >;

    return Response.json(
      mapChatResponseToResponsesPayload(
        prepared.defaults,
        prepared.transcript,
        prepared.model,
        prepared.previousResponseId,
        upstreamPayload,
      ),
    );
  } catch (error) {
    return createErrorResponse(
      error instanceof Error && error.message.includes('previous_response_id')
        ? 400
        : 500,
      error instanceof Error ? error.message : 'Unexpected responses error',
    );
  }
};

export const resetResponseSessions = (): void => {
  getSessionStore().clear();
};
