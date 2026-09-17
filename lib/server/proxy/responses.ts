import type { NextRequest } from 'next/server';

import {
  getDefaultModel,
  isWebFetchEnabled,
  isWebSearchEnabled,
} from '../domain/config';
import { getCredentialSupportedModels } from '../domain/credentials';
import type { DebugTrace } from '../domain/debug';
import {
  buildWebFetchToolDefinition,
  buildWebSearchToolDefinition,
  markServerTool,
  normalizeToolName,
  WEB_FETCH_TOOL_NAME,
  WEB_FETCH_TOOL_TYPE_PREFIX,
  WEB_SEARCH_TOOL_NAME,
  WEB_SEARCH_TOOL_TYPE_PREFIX,
} from '../search/tool';
import {
  buildImageGenerationChatTool,
  executeImageGenerationLoop,
  IMAGE_GENERATION_CHAT_TOOL_NAME,
  IMAGE_GENERATION_TOOL_TYPE,
} from './image-generation';
import {
  extractImageUrl,
  isImageContentPart,
  proxyChatCompletions,
  proxyResponsesUpstream,
  resolveProxyContext,
  resolveProxyContextByCredentialFilename,
  type ProxyContext,
} from './codebuddy';
import {
  getServerToolExecutions,
  type ServerToolExecution,
  type ServerToolInvocation,
} from './web-search-loop';
import { resolveRequestAccessKey } from './auth';
import { createErrorResponse } from '../shared/http';
import {
  createStreamCloser,
  readTimeoutFrame,
  responsesStreamErrorChunks,
  toUpstreamTimeoutMessage,
} from '../shared/upstream-timeout';
import {
  deleteStorageJson,
  getStorageBackendMeta,
  listStorageJson,
  readStorageJson,
  writeStorageJson,
} from '../storage';

interface ResponsesInputItem {
  type?: string;
  role?: string;
  content?: unknown;
  text?: string;
  arguments?: string;
  output?: unknown;
  name?: string;
  call_id?: string;
  tools?: Array<{ type?: string; name?: string } & Record<string, unknown>>;
  /**
   * Present on `reasoning` items a client replays from an earlier response.
   * We put the reasoning here verbatim; clients echo it back untouched.
   * A compaction item carries the same field.
   */
  encrypted_content?: string;
  /**
   * Reasoning summaries. The Agents SDK sends these back as
   * `summary: [{type: 'summary_text', text}]`.
   */
  summary?: unknown;
}

interface SupportedChatTool {
  chatName: string;
  kind: 'custom' | 'function' | 'mcp' | 'tool_search';
  namespace?: string;
  originalName: string;
  /**
   * True when the client declared this as a provider-executed server tool
   * (`web_search_20260209`, `web_fetch_20250910`, `web_search_preview`) rather
   * than as its own function.
   *
   * Translation turns both into ordinary functions for upstream, so without this
   * the proxy cannot tell them apart later — and the difference decides whether a
   * tool that cannot be executed is dropped or forwarded.
   */
  serverDeclared?: boolean;
  serverLabel?: string;
  tool: Record<string, unknown>;
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
  accessKeyId: string | null;
  credentialFilename: string | null;
  createdAt: number;
  id: string;
  model: string;
  transcript: TranscriptMessage[];
  defaults: ResponseSessionDefaults;
  upstreamProtocol?: 'chat' | 'responses';
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
  /** Reasoning the upstream produced alongside `content`. */
  reasoning_content?: string;
  reasoning?: string;
}

interface ChatImagePart {
  image_url: { url: string };
  type: 'image_url';
}

interface ChatTextPart {
  text: string;
  type: 'text';
}

type ChatContentPart = string | ChatTextPart | ChatImagePart;

/**
 * Transcript content. Images are kept as structured parts so they survive the
 * Chat-shaped round trip through the transcript and reach the model as images
 * instead of a JSON dump.
 */
type TranscriptContent = string | ChatContentPart[];

interface TranscriptMessage {
  role: string;
  content: TranscriptContent | null;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
  /**
   * Prior-turn reasoning recovered from a replayed reasoning item.
   *
   * Carried on the assistant message the reasoning belongs to rather than sent
   * as its own message: the chat upstream has no standalone reasoning entry,
   * and a reasoning-only message would be an empty turn.
   */
  reasoning?: string;
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

interface StreamingMessageState {
  outputIndex: number | null;
  outputItemId: string;
}

interface ResponsesServerToolItem {
  completed: Record<string, unknown>;
  inProgress: Record<string, unknown>;
  outputIndex: number;
}

interface ResponseSessionMetadata {
  bytes: number;
  createdAt: number;
}

type SupportedResponsesTool = NonNullable<
  ResponsesRequestBody['tools']
>[number];

const TOOL_SEARCH_PROXY_NAME = 'tool_search';
const CUSTOM_TOOL_INPUT_FIELD = 'input';
const CUSTOM_TOOL_INPUT_DESCRIPTION =
  'Raw string input for the original custom tool.';
const MAX_RESPONSE_SESSIONS = 1_000;
const RESPONSE_SESSION_TTL_MS = 60 * 60 * 1000;
const MAX_RESPONSE_SESSION_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_SESSION_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_RESPONSE_TRANSCRIPT_MESSAGES = 200;
const RESPONSE_SESSION_NAMESPACE = 'responses';
const RESPONSE_SESSION_INDEX_NAMESPACE = 'response-session-index';
const MAX_STREAM_BUFFER_LENGTH = 1_000_000;
const MAX_STREAM_TEXT_LENGTH = 2_000_000;
const MAX_TOOL_ARGUMENT_LENGTH = 1_000_000;
const MAX_TOOL_NAME_LENGTH = 256;

const globalResponsesState = globalThis as typeof globalThis & {
  __codebuddy2apiResponseSessions__?: Map<string, ResponseSession>;
  __codebuddy2apiResponseSessionBytes__?: Map<string, number>;
  __codebuddy2apiResponseSessionTotalBytes__?: number;
};

const getSessionStore = (): Map<string, ResponseSession> => {
  if (!globalResponsesState.__codebuddy2apiResponseSessions__) {
    globalResponsesState.__codebuddy2apiResponseSessions__ = new Map();
  }

  return globalResponsesState.__codebuddy2apiResponseSessions__;
};

const getSessionByteStore = (): Map<string, number> => {
  if (!globalResponsesState.__codebuddy2apiResponseSessionBytes__) {
    globalResponsesState.__codebuddy2apiResponseSessionBytes__ = new Map();
  }

  return globalResponsesState.__codebuddy2apiResponseSessionBytes__;
};

const getSessionTotalBytes = (): number => {
  return globalResponsesState.__codebuddy2apiResponseSessionTotalBytes__ ?? 0;
};

const setSessionTotalBytes = (value: number): void => {
  globalResponsesState.__codebuddy2apiResponseSessionTotalBytes__ = value;
};

const removeLocalResponseSession = (id: string): void => {
  const byteStore = getSessionByteStore();
  const store = getSessionStore();
  const bytes = byteStore.get(id) ?? 0;
  store.delete(id);
  byteStore.delete(id);
  setSessionTotalBytes(Math.max(0, getSessionTotalBytes() - bytes));
};

const pruneResponseSessions = (): void => {
  const store = getSessionStore();
  const expiresBefore = Date.now() - RESPONSE_SESSION_TTL_MS;

  for (const [id, session] of store) {
    if (session.createdAt <= expiresBefore) {
      removeLocalResponseSession(id);
    }
  }

  while (
    store.size > MAX_RESPONSE_SESSIONS ||
    getSessionTotalBytes() > MAX_RESPONSE_SESSION_TOTAL_BYTES
  ) {
    const oldestId = store.keys().next().value;

    // Guard against a byte total that has drifted out of step with the map.
    // Without this, an empty map with a positive total makes the removal a
    // no-op and spins here forever, blocking the event loop.
    if (oldestId === undefined) {
      setSessionTotalBytes(0);
      break;
    }

    removeLocalResponseSession(oldestId);
  }
};

const prunePgResponseSessions = async (): Promise<void> => {
  const metadataDocuments = await listStorageJson<ResponseSessionMetadata>(
    RESPONSE_SESSION_INDEX_NAMESPACE,
  );
  const expiresBefore = Date.now() - RESPONSE_SESSION_TTL_MS;
  const candidates = metadataDocuments
    .map((document) => ({ key: document.key, ...document.value }))
    .sort((left, right) => left.createdAt - right.createdAt);
  const toDelete = candidates.filter(
    (candidate) => candidate.createdAt <= expiresBefore,
  );
  const remaining = candidates.filter(
    (candidate) => candidate.createdAt > expiresBefore,
  );
  let totalBytes = remaining.reduce(
    (total, candidate) => total + candidate.bytes,
    0,
  );

  while (
    remaining.length > MAX_RESPONSE_SESSIONS ||
    totalBytes > MAX_RESPONSE_SESSION_TOTAL_BYTES
  ) {
    const candidate = remaining.shift()!;
    toDelete.push(candidate);
    totalBytes -= candidate.bytes;
  }

  await Promise.all(
    toDelete.flatMap((candidate) => [
      deleteStorageJson(RESPONSE_SESSION_NAMESPACE, candidate.key),
      deleteStorageJson(RESPONSE_SESSION_INDEX_NAMESPACE, candidate.key),
    ]),
  );
};

const isPgResponseSessionStore = (): boolean => {
  return getStorageBackendMeta().backend === 'pg';
};

const getResponseSession = async (
  id: string,
): Promise<ResponseSession | undefined> => {
  if (isPgResponseSessionStore()) {
    const session = await readStorageJson<ResponseSession>(
      RESPONSE_SESSION_NAMESPACE,
      id,
    );
    if (!session || session.createdAt <= Date.now() - RESPONSE_SESSION_TTL_MS) {
      if (session) {
        await deleteStorageJson(RESPONSE_SESSION_NAMESPACE, id);
        await deleteStorageJson(RESPONSE_SESSION_INDEX_NAMESPACE, id);
      }
      return undefined;
    }
    return session;
  }

  pruneResponseSessions();
  return getSessionStore().get(id);
};

const getValidatedPreviousSession = async (
  previousResponseId: string | null,
  accessKeyId: string | null,
): Promise<ResponseSession | undefined> => {
  const previousSession = previousResponseId
    ? await getResponseSession(previousResponseId)
    : undefined;

  if (
    previousResponseId &&
    (!previousSession || previousSession.accessKeyId !== accessKeyId)
  ) {
    throw new Error('Unknown or expired previous_response_id');
  }

  return previousSession;
};

const storeResponseSession = async (
  session: ResponseSession,
): Promise<void> => {
  const serialized = JSON.stringify(session);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_RESPONSE_SESSION_BYTES) {
    throw new Error('Response session exceeds the maximum size');
  }

  if (isPgResponseSessionStore()) {
    await writeStorageJson(RESPONSE_SESSION_NAMESPACE, session.id, session);
    await writeStorageJson(RESPONSE_SESSION_INDEX_NAMESPACE, session.id, {
      bytes: Buffer.byteLength(serialized, 'utf8'),
      createdAt: session.createdAt,
    });
    try {
      await prunePgResponseSessions();
    } catch (error) {
      console.warn('[CodeBuddy2API] Unable to prune Responses sessions', error);
    }
    return;
  }

  const store = getSessionStore();
  const byteStore = getSessionByteStore();
  const previousBytes = byteStore.get(session.id) ?? 0;
  const sessionBytes = Buffer.byteLength(serialized, 'utf8');
  store.set(session.id, session);
  byteStore.set(session.id, sessionBytes);
  setSessionTotalBytes(getSessionTotalBytes() - previousBytes + sessionBytes);
  pruneResponseSessions();
};

const storeUpstreamResponseBinding = async ({
  model,
  proxyContext,
  responseId,
}: {
  model: string;
  proxyContext: ProxyContext;
  responseId: string;
}): Promise<void> => {
  await storeResponseSession({
    accessKeyId: proxyContext.accessKeyId,
    credentialFilename: proxyContext.credentialFilename,
    createdAt: Date.now(),
    defaults: {},
    id: responseId,
    model,
    transcript: [],
    upstreamProtocol: 'responses',
  });
};

const flattenNamespaceToolName = (namespace: string, name: string): string => {
  return `${namespace}__${name}`;
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

const buildCustomToolDefinition = (
  tool: Record<string, unknown>,
): Record<string, unknown> | null => {
  const name = typeof tool.name === 'string' ? tool.name.trim() : '';

  if (!name) {
    return null;
  }

  const description =
    typeof tool.description === 'string' && tool.description.trim()
      ? tool.description
      : `Custom tool ${name}`;

  return {
    name,
    description,
    parameters: {
      type: 'object',
      properties: {
        [CUSTOM_TOOL_INPUT_FIELD]: {
          type: 'string',
          description: CUSTOM_TOOL_INPUT_DESCRIPTION,
        },
      },
      required: [CUSTOM_TOOL_INPUT_FIELD],
    },
  };
};

const buildToolSearchDefinition = (): Record<string, unknown> => {
  return {
    name: TOOL_SEARCH_PROXY_NAME,
    description:
      'Search and load Codex tools, plugins, connectors, and MCP namespaces for the current task.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query for tools or connectors to load.',
        },
        limit: {
          type: 'integer',
          description: 'Maximum number of tool groups to return.',
        },
      },
      required: ['query'],
    },
  };
};

const toSupportedChatTool = (
  tool: SupportedResponsesTool,
  namespace?: string,
): SupportedChatTool[] => {
  const toolType = typeof tool.type === 'string' ? tool.type : 'function';

  // Server-side search and fetch carry no function schema, so the generic
  // branch below drops them. Emit them as functions unconditionally and let
  // the proxy loop resolve the configured backend asynchronously. SearXNG
  // needs local configuration, while CodeBuddy search does not.
  if (
    normalizeToolName(toolType).startsWith(
      normalizeToolName(WEB_SEARCH_TOOL_TYPE_PREFIX),
    )
  ) {
    const definition = buildWebSearchToolDefinition();

    return [
      {
        chatName: WEB_SEARCH_TOOL_NAME,
        kind: 'function',
        originalName: WEB_SEARCH_TOOL_NAME,
        serverDeclared: true,
        tool: definition,
      },
    ];
  }

  // Fetch needs no deployment-level configuration — the local backend is always
  // available and the CodeBuddy backend needs only a credential — so it is
  // advertised unconditionally and gated later by the enable toggle.
  if (
    normalizeToolName(toolType).startsWith(
      normalizeToolName(WEB_FETCH_TOOL_TYPE_PREFIX),
    )
  ) {
    const definition = buildWebFetchToolDefinition();

    return [
      {
        chatName: WEB_FETCH_TOOL_NAME,
        kind: 'function',
        originalName: WEB_FETCH_TOOL_NAME,
        serverDeclared: true,
        tool: definition,
      },
    ];
  }

  // Image generation has no chat-protocol equivalent, so the declaration is
  // rewritten as a function and the call is executed by the proxy. It is
  // advertised only on the chat path: the responses passthrough hands the
  // native declaration straight to the upstream, which supports it.
  if (toolType === IMAGE_GENERATION_TOOL_TYPE) {
    return [
      {
        chatName: IMAGE_GENERATION_CHAT_TOOL_NAME,
        kind: 'function' as const,
        originalName: IMAGE_GENERATION_TOOL_TYPE,
        serverDeclared: true,
        tool: buildImageGenerationChatTool(),
      },
    ];
  }

  if (toolType === 'namespace') {
    const namespaceName = typeof tool.name === 'string' ? tool.name.trim() : '';
    const children = (
      Array.isArray(tool.tools)
        ? tool.tools
        : Array.isArray(tool.children)
          ? tool.children
          : []
    ).filter((item): item is SupportedResponsesTool => {
      return Boolean(item && typeof item === 'object');
    });

    if (!namespaceName || !children.length) {
      return [];
    }

    return children.flatMap((child) =>
      toSupportedChatTool(child, namespaceName),
    );
  }

  if (toolType === 'tool_search') {
    const definition = buildToolSearchDefinition();
    return [
      {
        chatName: TOOL_SEARCH_PROXY_NAME,
        kind: 'tool_search',
        originalName: TOOL_SEARCH_PROXY_NAME,
        tool: definition,
      },
    ];
  }

  if (toolType === 'custom') {
    const definition = buildCustomToolDefinition(tool);

    if (!definition || typeof definition.name !== 'string') {
      return [];
    }

    return [
      {
        chatName: definition.name,
        kind: 'custom',
        originalName: definition.name,
        tool: definition,
      },
    ];
  }

  const functionDef = extractFunctionDefinition(tool);

  if (!functionDef || typeof functionDef.name !== 'string') {
    return [];
  }

  const originalName = functionDef.name;
  const chatName = namespace
    ? flattenNamespaceToolName(namespace, originalName)
    : toolType === 'mcp' &&
        typeof tool.server_label === 'string' &&
        tool.server_label.trim()
      ? flattenNamespaceToolName(tool.server_label.trim(), originalName)
      : originalName;

  return [
    {
      chatName,
      kind: toolType === 'mcp' ? 'mcp' : 'function',
      namespace:
        namespace ||
        (typeof tool.server_label === 'string' ? tool.server_label : undefined),
      originalName,
      serverLabel:
        toolType === 'mcp' && typeof tool.server_label === 'string'
          ? tool.server_label
          : undefined,
      tool: {
        ...functionDef,
        name: chatName,
      },
    },
  ];
};

/**
 * True when the client declared an `image_generation` tool. Gating on this
 * keeps the ordinary path free of an extra upstream round trip.
 */
const hasImageGenerationTool = (
  tools: ResponsesRequestBody['tools'],
): boolean => {
  return Boolean(
    tools?.some(
      (tool) =>
        typeof tool?.type === 'string' &&
        tool.type.toLowerCase().replaceAll('-', '_') ===
          IMAGE_GENERATION_TOOL_TYPE,
    ),
  );
};

const getSupportedChatTools = (
  tools: ResponsesRequestBody['tools'],
): SupportedChatTool[] => {
  if (!tools?.length) {
    return [];
  }

  return tools.flatMap((tool) => toSupportedChatTool(tool));
};

const findSupportedToolByName = (
  tools: ResponsesRequestBody['tools'],
  name: string,
): SupportedChatTool | null => {
  if (!tools?.length || !name) {
    return null;
  }

  return (
    getSupportedChatTools(tools).find(
      (tool) => tool.chatName === name || tool.originalName === name,
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

  return getSupportedChatTools(tools).some((tool) => {
    const name = tool.chatName;
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
  const itemType = originalTool?.kind === 'mcp' ? 'mcp_call' : 'function_call';
  const item: Record<string, unknown> = {
    id: toolCall.id,
    type: itemType,
    call_id: toolCall.callId,
    name: originalTool?.originalName ?? toolCall.name ?? 'function',
    arguments: toolCall.arguments,
    status: toolCall.status,
  };

  if (originalTool?.kind === 'mcp' && originalTool.serverLabel) {
    item.server_label = originalTool.serverLabel;
  }

  if (originalTool?.kind === 'function' && originalTool.namespace) {
    item.namespace = originalTool.namespace;
  }

  return item;
};

const getResponsesToolCallArgumentDeltaEventType = (
  tools: ResponsesRequestBody['tools'],
  name: string,
):
  | 'response.function_call_arguments.delta'
  | 'response.mcp_call_arguments.delta' => {
  return findSupportedToolByName(tools, name)?.kind === 'mcp'
    ? 'response.mcp_call_arguments.delta'
    : 'response.function_call_arguments.delta';
};

const buildAssistantTranscriptToolCalls = (
  toolCalls: ChatResponseToolCall[],
  tools?: ResponsesRequestBody['tools'],
): TranscriptMessage['tool_calls'] | undefined => {
  if (!toolCalls.length) {
    return undefined;
  }

  return toolCalls.map((toolCall, index) => ({
    id: normalizeToolCallId(toolCall.id, index),
    type: 'function',
    function: {
      name:
        findSupportedToolByName(tools, toolCall.function?.name ?? '')
          ?.originalName ??
        toolCall.function?.name ??
        'function',
      arguments: toolCall.function?.arguments ?? '',
    },
  }));
};

const buildStreamingAssistantTranscriptToolCalls = (
  toolCallStates: StreamingToolCallState[],
  tools?: ResponsesRequestBody['tools'],
): TranscriptMessage['tool_calls'] | undefined => {
  if (!toolCallStates.length) {
    return undefined;
  }

  return toolCallStates.map((toolCallState) => ({
    id: toolCallState.callId,
    type: 'function',
    function: {
      arguments: toolCallState.arguments,
      name:
        findSupportedToolByName(tools, toolCallState.name)?.originalName ??
        toolCallState.name,
    },
  }));
};

const getAssistantTranscriptContent = (
  outputText: string,
  toolCalls: TranscriptMessage['tool_calls'] | undefined,
): string | null => {
  return toolCalls?.length ? outputText || null : outputText;
};

/**
 * Keeps image parts as structured content so the chat path can rebuild them
 * upstream. Text parts are still flattened: the transcript is persisted across
 * turns and replayed as Chat messages, and the Responses converter only
 * recognises images in the OpenAI `image_url` shape.
 */
const mapInputContentToTranscriptContent = (
  content: unknown,
): TranscriptContent | null => {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return null;
  }

  const parts = content.filter((part) => part !== null && part !== undefined);

  if (!parts.some(isImageContentPart)) {
    return null;
  }

  const mapped = parts.flatMap((part): ChatContentPart[] => {
    if (typeof part === 'string') {
      return [part];
    }

    if (isImageContentPart(part)) {
      const imageUrl = extractImageUrl(part);

      return imageUrl
        ? [{ image_url: { url: imageUrl }, type: 'image_url' }]
        : [];
    }

    if (part && typeof part === 'object' && 'text' in part) {
      return [String((part as { text?: unknown }).text ?? '')];
    }

    return [];
  });

  return mapped.length ? mapped : null;
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

/**
 * Marks an `encrypted_content` value we minted, so we can tell it apart from a
 * blob issued by someone else.
 *
 * Not a security measure. Codex never opens this field — it only echoes it — so
 * plaintext round-trips fine, but a marker is what stops us from reading a
 * genuinely encrypted blob as if it were reasoning text.
 */
const REASONING_PREFIX = 'cbreason1:';

/**
 * Pulls readable reasoning out of a replayed `reasoning` item.
 *
 * Only values we minted are used: anything else — an OpenAI-issued blob, say —
 * is opaque ciphertext, and forwarding it upstream would send gibberish where
 * reasoning belongs. The summary is the fallback in that case.
 *
 * The Agents SDK sends summaries as `summary: [{type: 'summary_text', text}]`,
 * so a client that never received our blob still gets its reasoning through.
 */
const extractReasoningFromItem = (item: ResponsesInputItem): string => {
  const blob = item.encrypted_content;

  if (typeof blob === 'string' && blob.startsWith(REASONING_PREFIX)) {
    return blob.slice(REASONING_PREFIX.length);
  }

  if (!Array.isArray(item.summary)) {
    return '';
  }

  return item.summary
    .map((entry) => {
      if (typeof entry === 'string') {
        return entry;
      }

      if (entry && typeof entry === 'object' && 'text' in entry) {
        return String((entry as { text?: unknown }).text ?? '');
      }

      return '';
    })
    .join('');
};

const mapInputItemToMessage = (
  item: ResponsesInputItem,
): TranscriptMessage | null => {
  if (item.type === 'reasoning' || item.type === 'compaction') {
    // Reasoning is not a message. Without this branch the item fell through to
    // the plain-message case at the bottom, where it has neither `role` nor
    // `content` — becoming an empty `{role:'user', content:''}` entry that the
    // chat upstream sees as a turn the user never sent, repeated on every
    // later turn of the conversation.
    //
    // Signal the reasoning back to the caller instead, which attaches it to the
    // assistant message it accompanies. Returning `null` when there is nothing
    // to recover keeps an empty reasoning item from emitting a message at all.
    const reasoning = extractReasoningFromItem(item);

    return reasoning ? { role: 'assistant', content: null, reasoning } : null;
  }

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
    // A tool may return an image, e.g. a screenshot. Keep it structured so the
    // Responses converter can rebuild it as an image; stringifying would hand
    // the model the base64 payload as text.
    const outputContent =
      mapInputContentToTranscriptContent(item.output) ??
      stringifyContent(item.output);

    if (item.call_id) {
      return {
        role: 'tool',
        content: outputContent,
        tool_call_id: item.call_id,
      };
    }

    return {
      role: 'user',
      content: outputContent,
    };
  }

  if (item.type === 'mcp_approval_response') {
    return {
      role: 'user',
      content: JSON.stringify(item),
    };
  }

  // Every other item type returns above, so what is left is a plain message:
  // either one with a declared `type: 'message'`, or one carrying only
  // `role`/`content`. Images are kept structured so the chat path can rebuild
  // them; a message without an image stays flattened.
  const imageContent = mapInputContentToTranscriptContent(item.content);

  if (imageContent !== null) {
    return {
      role: item.role ?? 'user',
      content: imageContent,
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

const createResponseReasoningId = (): string => {
  return `rs_${crypto.randomUUID().replaceAll('-', '')}`;
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

  const supported = getSupportedChatTools(tools);
  if (!supported.length) {
    return undefined;
  }

  return supported.map((tool) => {
    return {
      type: 'function',
      function: tool.tool,
      ...(tool.serverDeclared ? markServerTool({}) : {}),
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

const translateResponsesToolChoiceToChatWithTools = (
  tools: ResponsesRequestBody['tools'],
  toolChoice: unknown,
): unknown => {
  const translated = translateResponsesToolChoiceToChat(toolChoice);

  if (typeof translated !== 'object' || translated === null) {
    return translated;
  }

  const choice = translated as Record<string, unknown>;

  if (
    choice.type === 'function' &&
    typeof choice.function === 'object' &&
    choice.function !== null
  ) {
    const functionChoice = choice.function as Record<string, unknown>;
    if (typeof functionChoice.name === 'string') {
      return {
        ...choice,
        function: {
          ...functionChoice,
          name: resolveChatToolName(tools, functionChoice.name),
        },
      };
    }
  }

  return translated;
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
  const supportedTools = getSupportedChatTools(tools);

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
        .map((tool) => tool.originalName)
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

const prepareTranscript = async (
  body: ResponsesRequestBody,
  accessKeyId: string | null,
  previousSession?: ResponseSession,
): Promise<{
  defaults: ResponseSessionDefaults;
  model: string;
  transcript: TranscriptMessage[];
  previousResponseId: string | null;
}> => {
  const previousResponseId = body.previous_response_id ?? null;
  const resolvedPreviousSession =
    previousSession ??
    (await getValidatedPreviousSession(previousResponseId, accessKeyId));

  const transcript = (resolvedPreviousSession?.transcript ?? []).slice(
    -MAX_RESPONSE_TRANSCRIPT_MESSAGES,
  );
  // Reasoning recovered from replayed reasoning items, awaiting the assistant
  // message it belongs to. Declared here so it spans the whole input array.
  let pendingReasoning = '';
  while (transcript[0]?.role === 'tool') {
    transcript.shift();
  }
  const model =
    typeof body.model === 'string' && body.model.trim()
      ? body.model
      : (resolvedPreviousSession?.model ?? (await getDefaultModel()));
  const additionalTools = Array.isArray(body.input)
    ? body.input.flatMap((item) =>
        item?.type === 'additional_tools' && Array.isArray(item.tools)
          ? item.tools
          : [],
      )
    : [];
  const baseTools = body.tools ?? resolvedPreviousSession?.defaults.tools;
  const requestTools = [...(baseTools ?? []), ...additionalTools];
  const defaults = {
    instructions:
      body.instructions ??
      resolvedPreviousSession?.defaults.instructions ??
      undefined,
    metadata:
      body.metadata ?? resolvedPreviousSession?.defaults.metadata ?? undefined,
    tools: requestTools.length > 0 ? requestTools : baseTools,
    tool_choice:
      body.tool_choice ??
      resolvedPreviousSession?.defaults.tool_choice ??
      undefined,
  };

  if (body.messages?.length) {
    body.messages.forEach((item) => {
      transcript.push({
        role: item.role ?? 'user',
        content:
          mapInputContentToTranscriptContent(item.content) ??
          stringifyContent(item.content),
      });
    });
  } else if (typeof body.input === 'string') {
    transcript.push({ role: 'user', content: body.input });
  } else if (Array.isArray(body.input)) {
    body.input.forEach((item) => {
      if (item.type === 'additional_tools') return;

      const message = mapInputItemToMessage(item);

      if (!message) {
        return;
      }

      // A reasoning item yields a reasoning-only entry. Fold it into the next
      // assistant message so the upstream sees the reasoning where it belongs
      // — attached to the turn that produced it — instead of as a bare turn.
      // Anything left unconsumed at the end is dropped: reasoning with no
      // following assistant message has nothing to attach to.
      if (message.reasoning && !message.content && !message.tool_calls) {
        pendingReasoning += message.reasoning;
        return;
      }

      if (pendingReasoning) {
        message.reasoning = message.reasoning
          ? `${pendingReasoning}${message.reasoning}`
          : pendingReasoning;
        pendingReasoning = '';
      }

      transcript.push(message);
    });
  }

  return {
    defaults,
    model,
    transcript,
    previousResponseId,
  };
};

const resolveChatToolName = (
  tools: ResponsesRequestBody['tools'],
  name: string,
): string => {
  return findSupportedToolByName(tools, name)?.chatName ?? name;
};

const normalizeTranscriptMessageToolNames = (
  transcript: TranscriptMessage[],
  tools: ResponsesRequestBody['tools'],
): TranscriptMessage[] => {
  return transcript.map((message) => {
    if (!message.tool_calls?.length) {
      return message;
    }

    return {
      ...message,
      tool_calls: message.tool_calls.map((toolCall) => ({
        ...toolCall,
        function: {
          ...toolCall.function,
          name: resolveChatToolName(tools, toolCall.function.name),
        },
      })),
    };
  });
};

const toResponsesUsageNumber = (value: unknown): number => {
  const numeric =
    typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));

  if (!Number.isFinite(numeric) || numeric < 0) {
    return 0;
  }

  return numeric;
};

const mapChatUsageToResponses = (usage: unknown): Record<string, unknown> => {
  if (!usage || typeof usage !== 'object') {
    return {
      input_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 0,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 0,
    };
  }

  const value = usage as {
    cache_creation_input_tokens?: unknown;
    cache_read_input_tokens?: unknown;
    completion_tokens?: unknown;
    completion_tokens_details?: { reasoning_tokens?: unknown };
    completion_thinking_tokens?: unknown;
    input_tokens_details?: { cached_tokens?: unknown };
    prompt_cache_hit_tokens?: unknown;
    prompt_cache_miss_tokens?: unknown;
    prompt_cache_write_tokens?: unknown;
    prompt_tokens?: unknown;
    prompt_tokens_details?: {
      cache_creation_tokens?: unknown;
      cached_tokens?: unknown;
    };
    total_tokens?: unknown;
  };
  const outputTokens = toResponsesUsageNumber(value.completion_tokens);
  const cachedTokens = toResponsesUsageNumber(
    value.prompt_tokens_details?.cached_tokens ??
      value.input_tokens_details?.cached_tokens ??
      value.cache_read_input_tokens ??
      value.prompt_cache_hit_tokens,
  );
  const cacheCreationTokens = toResponsesUsageNumber(
    value.prompt_tokens_details?.cache_creation_tokens ??
      value.cache_creation_input_tokens ??
      value.prompt_cache_write_tokens,
  );
  const reasoningTokens = toResponsesUsageNumber(
    value.completion_tokens_details?.reasoning_tokens ??
      value.completion_thinking_tokens,
  );
  // Chat usage is the single source of truth for both shapes. Keep the
  // Responses counters faithful to it so clients never see zeroed metrics.
  // prompt_tokens already covers its cached and created subsets, so the
  // split counters are only summed when prompt_tokens is missing. Otherwise
  // cached tokens would exceed the reported input total.
  const inputTokens = toResponsesUsageNumber(
    value.prompt_tokens ??
      toResponsesUsageNumber(value.prompt_cache_miss_tokens) +
        cachedTokens +
        cacheCreationTokens,
  );

  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: cachedTokens },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: reasoningTokens },
    total_tokens:
      toResponsesUsageNumber(value.total_tokens) || inputTokens + outputTokens,
  };
};

const mapChatResponseToResponsesPayload = async (
  accessKeyId: string | null,
  credentialFilename: string | null,
  defaults: ResponseSessionDefaults,
  transcript: TranscriptMessage[],
  model: string,
  previousResponseId: string | null,
  upstreamPayload: Record<string, unknown>,
  serverToolExecutions: ServerToolExecution[],
): Promise<Record<string, unknown>> => {
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
  const output: Array<Record<string, unknown>> = serverToolExecutions.map(
    (execution) => buildResponsesWebSearchCallItem(execution, 'completed'),
  );
  const transcriptToolCalls = buildAssistantTranscriptToolCalls(
    toolCalls,
    defaults.tools,
  );

  // Emit the reasoning as its own item, ahead of the message it produced.
  //
  // Clients replay `output` verbatim on the next turn, so this is what lets a
  // stateless Responses client carry reasoning forward. Without it the only
  // reasoning we ever hand back is a transient `reasoning_text.delta`, which no
  // client can replay because it has no id and no blob to send back.
  //
  // `encrypted_content` holds the reasoning verbatim, not ciphertext. Codex
  // never opens it — it only echoes it — so plaintext round-trips exactly as
  // well, and encrypting would obscure a value that carries no secret: the
  // upstream gave us a summary, and the `summary` field below already shows it.
  const reasoningText =
    firstChoice.message?.reasoning_content ??
    firstChoice.message?.reasoning ??
    '';

  if (reasoningText) {
    output.push({
      id: createResponseReasoningId(),
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: reasoningText }],
      encrypted_content: `${REASONING_PREFIX}${reasoningText}`,
      status: 'completed',
    });
  }

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

  await storeResponseSession({
    accessKeyId,
    credentialFilename,
    createdAt: Date.now(),
    id: responseId,
    model,
    transcript: [
      ...transcript,
      {
        role: 'assistant',
        content: getAssistantTranscriptContent(outputText, transcriptToolCalls),
        ...(transcriptToolCalls ? { tool_calls: transcriptToolCalls } : {}),
        // A client that continues via `previous_response_id` rather than
        // replaying `output` never sees the reasoning item, so the session is
        // the only place the reasoning can survive into the next turn.
        ...(reasoningText ? { reasoning: reasoningText } : {}),
      },
    ],
    defaults,
    upstreamProtocol: 'chat',
  });

  return {
    id: responseId,
    object: 'response',
    created_at: createdAt,
    status: 'completed',
    model,
    output,
    output_text: outputText,
    usage: mapChatUsageToResponses(upstreamPayload.usage),
    metadata: defaults.metadata ?? {},
    previous_response_id: previousResponseId,
  };
};

const buildResponsesWebSearchCallItem = (
  execution: ServerToolExecution | ServerToolInvocation,
  status: 'completed' | 'in_progress',
  id = `ws_${crypto.randomUUID().replaceAll('-', '')}`,
): Record<string, unknown> => ({
  id,
  type: 'web_search_call',
  status,
  action:
    execution.type === 'web_search'
      ? { type: 'search', query: execution.input.query }
      : {
          type: 'open_page',
          url:
            'result' in execution
              ? (execution.result.url ?? execution.input.url)
              : execution.input.url,
        },
});

const mapChatStreamToResponsesEventStream = (
  upstreamResponse: Response,
  defaults: ResponseSessionDefaults,
  transcript: TranscriptMessage[],
  model: string,
  previousResponseId: string | null,
  proxyContext: ProxyContext,
  responseId = createResponseId(),
  providedServerToolItems?: ResponsesServerToolItem[],
  emitOpeningEvents = true,
  emitServerToolLifecycle = true,
  providedOutputIndexAllocator?: () => number,
  rejectErrorPayloads = false,
): Response => {
  if (!upstreamResponse.ok || !upstreamResponse.body) {
    return upstreamResponse;
  }

  const serverToolItems =
    providedServerToolItems ??
    getServerToolExecutions(upstreamResponse).map((execution, outputIndex) => {
      const id = `ws_${crypto.randomUUID().replaceAll('-', '')}`;

      return {
        completed: buildResponsesWebSearchCallItem(execution, 'completed', id),
        inProgress: buildResponsesWebSearchCallItem(
          execution,
          'in_progress',
          id,
        ),
        outputIndex,
      };
    });
  let outputText = '';
  // Reasoning accumulated from stream deltas. The delta events alone are not
  // replayable — a client needs a reasoning item in the completed output, with
  // a blob of its own, to send anything back on the next turn.
  let streamedReasoning = '';
  // Claimed on the first reasoning delta, which lands before any text, so the
  // item sorts ahead of the message it produced.
  let reasoningOutputIndex: number | null = null;
  let reasoningItemAdded = false;
  // Fixed when the first reasoning delta arrives, so the `output_item.added`
  // event and the completed output reference the same id.
  let reasoningItemId = '';

  let nextOutputIndex =
    serverToolItems.reduce(
      (maximum, item) => Math.max(maximum, item.outputIndex),
      -1,
    ) + 1;
  const allocateOutputIndex =
    providedOutputIndexAllocator ?? (() => nextOutputIndex++);
  const messageState: StreamingMessageState = {
    outputIndex: null,
    outputItemId: createMessageId(),
  };
  let messageAddedEmitted = false;
  const toolCallStates = new Map<string, StreamingToolCallState>();
  const toolCallStateKeys = new Map<string, string>();
  let latestUsage: unknown = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let cancelled = false;
  const closer = createStreamCloser();
  const releaseReader = (): void => {
    reader?.releaseLock();
    reader = null;
  };

  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const upstreamReader = upstreamResponse.body!.getReader();
      reader = upstreamReader;
      let buffer = '';
      let totalToolArgumentLength = 0;
      let streamRejected = false;

      const enqueueEvent = (payload: Record<string, unknown>): void => {
        const eventType =
          typeof payload.type === 'string' ? payload.type : 'message';
        controller.enqueue(
          encoder.encode(
            `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`,
          ),
        );
      };

      const buildStreamingMessageItem = (
        status: 'completed' | 'in_progress',
      ): Record<string, unknown> => ({
        id: messageState.outputItemId,
        type: 'message',
        role: 'assistant',
        status,
        content: [
          {
            type: 'output_text',
            text: outputText,
            annotations: [],
          },
        ],
      });

      // Carries the reasoning verbatim rather than encrypted — same reasoning as
      // the non-streaming item above.
      const buildStreamingReasoningItem = (): Record<string, unknown> => ({
        id: reasoningItemId,
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: streamedReasoning }],
        encrypted_content: `${REASONING_PREFIX}${streamedReasoning}`,
        status: 'completed',
      });

      const ensureReasoningItemAdded = (): void => {
        if (reasoningItemAdded) {
          return;
        }

        reasoningOutputIndex ??= allocateOutputIndex();
        enqueueEvent({
          type: 'response.output_item.added',
          item: buildStreamingReasoningItem(),
          output_index: reasoningOutputIndex,
          response_id: responseId,
        });
        reasoningItemAdded = true;
      };

      const ensureMessageAdded = (): void => {
        if (messageAddedEmitted) {
          return;
        }

        messageState.outputIndex ??= allocateOutputIndex();
        enqueueEvent({
          type: 'response.output_item.added',
          item: buildStreamingMessageItem('in_progress'),
          output_index: messageState.outputIndex,
          response_id: responseId,
        });
        messageAddedEmitted = true;
      };

      if (emitOpeningEvents) {
        enqueueEvent({
          type: 'response.created',
          response: {
            id: responseId,
            object: 'response',
            created_at: Math.floor(Date.now() / 1000),
            model,
            output: [],
          },
        });
        enqueueEvent({
          type: 'response.in_progress',
          response: {
            id: responseId,
            status: 'in_progress',
          },
        });
      }
      if (emitServerToolLifecycle) {
        serverToolItems.forEach(({ completed, inProgress, outputIndex }) => {
          const itemId = String(inProgress.id);
          enqueueEvent({
            type: 'response.output_item.added',
            item: inProgress,
            output_index: outputIndex,
            response_id: responseId,
          });
          enqueueEvent({
            type: 'response.web_search_call.in_progress',
            item_id: itemId,
            output_index: outputIndex,
          });
          enqueueEvent({
            type: 'response.web_search_call.searching',
            item_id: itemId,
            output_index: outputIndex,
          });
          enqueueEvent({
            type: 'response.web_search_call.completed',
            item_id: itemId,
            output_index: outputIndex,
          });
          enqueueEvent({
            type: 'response.output_item.done',
            item: completed,
            output_index: outputIndex,
            response_id: responseId,
          });
        });
      }

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
        while (true) {
          const { done, value } = await upstreamReader.read();

          if (cancelled) {
            return;
          }

          if (done) {
            const transcriptToolCalls =
              buildStreamingAssistantTranscriptToolCalls(
                [...toolCallStates.values()],
                defaults.tools,
              );
            try {
              await storeResponseSession({
                accessKeyId: proxyContext.accessKeyId,
                credentialFilename: proxyContext.credentialFilename,
                createdAt: Date.now(),
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
                    // Same reason as the non-streaming path: a client that
                    // continues via `previous_response_id` instead of
                    // replaying `output` would otherwise lose the reasoning.
                    ...(streamedReasoning
                      ? { reasoning: streamedReasoning }
                      : {}),
                  },
                ],
                defaults,
                upstreamProtocol: 'chat',
              });
            } catch (error) {
              console.error(
                '[CodeBuddy2API] Failed to persist Responses session',
                error,
              );
              enqueueEvent({
                type: 'response.error',
                error: { message: 'Failed to persist response session' },
              });
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              releaseReader();
              controller.close();
              return;
            }
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
              enqueueEvent({
                type: getResponsesToolCallArgumentDeltaEventType(
                  defaults.tools,
                  toolCallState.name,
                ).replace('.delta', '.done'),
                arguments: toolCallState.arguments,
                item_id: toolCallState.outputItemId,
                output_index: toolCallState.outputIndex,
                response_id: responseId,
              });
            });
            if (outputText) {
              ensureMessageAdded();
              enqueueEvent({
                type: 'response.output_text.done',
                item: buildStreamingMessageItem('completed'),
                output_index: messageState.outputIndex,
                response_id: responseId,
                text: outputText,
              });
              enqueueEvent({
                type: 'response.output_item.done',
                item: buildStreamingMessageItem('completed'),
                output_index: messageState.outputIndex,
                response_id: responseId,
              });
            }
            enqueueEvent({
              type: 'response.completed',
              response: {
                id: responseId,
                status: 'completed',
                output_text: outputText,
                previous_response_id: previousResponseId,
                usage: mapChatUsageToResponses(latestUsage),
                output: [
                  ...serverToolItems.map(({ completed, outputIndex }) => ({
                    item: completed,
                    outputIndex,
                  })),
                  // Streamed reasoning needs the same replayable item the
                  // non-streaming path emits. It sorts ahead of the message by
                  // taking the next index before the message claims its own —
                  // the deltas come first on the wire, so the item order has
                  // to match or a client replaying `output` scrambles it.
                  ...(streamedReasoning && reasoningOutputIndex !== null
                    ? [
                        {
                          item: buildStreamingReasoningItem(),
                          outputIndex: reasoningOutputIndex,
                        },
                      ]
                    : []),
                  ...(outputText && messageState.outputIndex !== null
                    ? [
                        {
                          item: buildStreamingMessageItem('completed'),
                          outputIndex: messageState.outputIndex,
                        },
                      ]
                    : []),
                  ...[...toolCallStates.values()].map((toolCallState) => ({
                    item: buildResponsesToolCallOutputItem(defaults.tools, {
                      arguments: toolCallState.arguments,
                      callId: toolCallState.callId,
                      id: toolCallState.outputItemId,
                      name: toolCallState.name || 'function',
                      status: 'completed',
                    }),
                    outputIndex: toolCallState.outputIndex,
                  })),
                ]
                  .sort((left, right) => left.outputIndex - right.outputIndex)
                  .map(({ item }) => item),
              },
            });
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            releaseReader();
            controller.close();
            return;
          }

          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split('\n\n');
          buffer = frames.pop()!;
          if (buffer.length > MAX_STREAM_BUFFER_LENGTH) {
            buffer = '';
          }

          for (const frame of frames) {
            if (streamRejected) {
              break;
            }
            if (frame.length > MAX_STREAM_BUFFER_LENGTH) {
              continue;
            }
            const line = frame
              .split('\n')
              .find((segment) => segment.startsWith('data: '));

            if (!line) {
              continue;
            }

            const raw = line.slice(6).trim();

            if (!raw || raw === '[DONE]') {
              continue;
            }

            // The upstream here is the chat pipeline, which reports a deadline
            // as a terminal error chunk and closes cleanly. Surfacing it keeps
            // the client from seeing an empty successful response.
            const upstreamError = readTimeoutFrame(frame);

            if (upstreamError !== null) {
              streamRejected = true;
              enqueueEvent({
                type: 'response.error',
                error: { message: upstreamError },
              });
              break;
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
                error?: unknown;
                usage?: unknown;
              };
              if (rejectErrorPayloads && payload.error) {
                const error =
                  typeof payload.error === 'object'
                    ? (payload.error as { message?: unknown })
                    : null;
                streamRejected = true;
                enqueueEvent({
                  type: 'response.error',
                  error: {
                    message:
                      typeof error?.message === 'string'
                        ? error.message
                        : typeof payload.error === 'string'
                          ? payload.error
                          : 'Upstream request failed',
                  },
                });
                break;
              }
              // The final upstream chunk carries the aggregated usage, so
              // remember it for the downstream response.completed event.
              if (payload.usage !== undefined) {
                latestUsage = payload.usage;
              }
              const delta = payload.choices?.[0]?.delta;

              if (delta?.content) {
                ensureMessageAdded();
                outputText = `${outputText}${delta.content}`;
                if (outputText.length > MAX_STREAM_TEXT_LENGTH) {
                  throw new Error('Response output exceeds the maximum size');
                }
                enqueueEvent({
                  type: 'response.output_text.delta',
                  delta: delta.content,
                  // Send only the item reference: embedding the accumulated
                  // text re-serializes it on every delta, which makes the
                  // enqueued volume quadratic in the output size. The full
                  // text still arrives intact in response.output_text.done
                  // and response.completed.
                  item_id: messageState.outputItemId,
                  output_index: messageState.outputIndex,
                  response_id: responseId,
                });
              }

              if (delta?.reasoning_content) {
                reasoningItemId ||= createResponseReasoningId();
                streamedReasoning += delta.reasoning_content;
                ensureReasoningItemAdded();
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
                const existing = toolCallStates.get(canonicalKey);
                const outputIndex = existing
                  ? existing.outputIndex
                  : allocateOutputIndex();
                const current = existing ?? {
                  addedEmitted: false,
                  arguments: '',
                  canonicalKey,
                  callId: normalizeToolCallId(toolCall.id, outputIndex),
                  name: '',
                  outputIndex,
                  outputItemId: createResponseOutputId(),
                  pendingArgumentDeltas: [],
                };

                if (toolCall.function?.name) {
                  if (
                    current.name.length + toolCall.function.name.length >
                    MAX_TOOL_NAME_LENGTH
                  ) {
                    throw new Error(
                      'Response tool name exceeds the maximum size',
                    );
                  }
                  current.name += toolCall.function.name;
                }
                maybeEmitToolCallAdded(current);

                if (toolCall.function?.arguments) {
                  if (
                    current.arguments.length +
                      toolCall.function.arguments.length >
                    MAX_TOOL_ARGUMENT_LENGTH
                  ) {
                    throw new Error(
                      'Response tool arguments exceed the maximum size',
                    );
                  }
                  if (
                    totalToolArgumentLength +
                      toolCall.function.arguments.length >
                    MAX_RESPONSE_SESSION_TOTAL_BYTES
                  ) {
                    throw new Error(
                      'Response tool arguments exceed the maximum size',
                    );
                  }
                  totalToolArgumentLength += toolCall.function.arguments.length;
                  current.arguments = `${current.arguments}${toolCall.function.arguments}`;
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
            } catch (error) {
              if (
                error instanceof Error &&
                error.message.includes('maximum size')
              ) {
                streamRejected = true;
              }
              console.error(
                '[CodeBuddy2API] Failed to parse upstream SSE frame',
                {
                  route: '/v1/responses',
                  frame: raw.slice(0, 1000),
                },
              );
              enqueueEvent({
                type: 'response.error',
                error: {
                  message: 'Failed to parse upstream SSE frame',
                },
              });
            }
          }

          if (streamRejected) {
            try {
              await reader!.cancel();
            } finally {
              releaseReader();
              controller.close();
            }
            return;
          }
        }
      };

      void pump().catch((error) => {
        if (cancelled) return;
        const timeoutMessage = toUpstreamTimeoutMessage(error);

        if (timeoutMessage === null) {
          closer.mark();
          controller.error(error);
          return;
        }

        streamRejected = true;
        void reader?.cancel().then(
          () => undefined,
          () => undefined,
        );
        releaseReader();
        closer.fail(controller, responsesStreamErrorChunks(timeoutMessage));
      });
    },
    async cancel(reason): Promise<void> {
      cancelled = true;
      closer.mark();
      try {
        await reader?.cancel(reason);
      } finally {
        releaseReader();
      }
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

const createResponsesEventStream = async (
  request: NextRequest,
  defaults: ResponseSessionDefaults,
  transcript: TranscriptMessage[],
  model: string,
  previousResponseId: string | null,
  maxOutputTokens: number | undefined,
  proxyContext: ProxyContext,
  debugTrace?: DebugTrace,
): Promise<Response> => {
  const translatedTools = translateResponsesToolsToChat(defaults.tools);
  const translatedToolNames = new Set(
    (
      (translatedTools ?? []) as Array<{
        function: { name: string };
      }>
    ).map((tool) => normalizeToolName(tool.function.name)),
  );
  const [searchEnabled, fetchEnabled] = await Promise.all([
    translatedToolNames.has(normalizeToolName(WEB_SEARCH_TOOL_NAME))
      ? isWebSearchEnabled()
      : false,
    translatedToolNames.has(normalizeToolName(WEB_FETCH_TOOL_NAME))
      ? isWebFetchEnabled()
      : false,
  ]);

  if (!searchEnabled && !fetchEnabled) {
    const upstreamResponse = await proxyChatCompletions(
      request,
      {
        model,
        messages: [
          ...(defaults.instructions
            ? [{ role: 'system', content: defaults.instructions }]
            : []),
          ...normalizeTranscriptMessageToolNames(transcript, defaults.tools),
        ],
        max_tokens: maxOutputTokens,
        stream: true,
        tools: translatedTools,
        tool_choice: translateResponsesToolChoiceToChatWithTools(
          defaults.tools,
          defaults.tool_choice,
        ),
      },
      proxyContext,
      debugTrace,
      '/v1/responses',
    );

    return mapChatStreamToResponsesEventStream(
      upstreamResponse,
      defaults,
      transcript,
      model,
      previousResponseId,
      proxyContext,
    );
  }

  const encoder = new TextEncoder();
  const responseId = createResponseId();
  const serverToolItems: ResponsesServerToolItem[] = [];
  const itemsByInvocationId = new Map<string, ResponsesServerToolItem>();
  let nextOutputIndex = 0;
  const allocateOutputIndex = (): number => nextOutputIndex++;
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let cancelled = false;

  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      const enqueueEvent = (
        payload: Record<string, unknown> & { type: string },
      ): void => {
        if (cancelled) return;
        controller.enqueue(
          encoder.encode(
            `event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`,
          ),
        );
      };

      enqueueEvent({
        type: 'response.created',
        response: {
          id: responseId,
          object: 'response',
          created_at: Math.floor(Date.now() / 1000),
          model,
          output: [],
        },
      });
      enqueueEvent({
        type: 'response.in_progress',
        response: { id: responseId, status: 'in_progress' },
      });

      const run = async (): Promise<void> => {
        const upstreamResponse = await proxyChatCompletions(
          request,
          {
            model,
            messages: [
              ...(defaults.instructions
                ? [{ role: 'system', content: defaults.instructions }]
                : []),
              ...normalizeTranscriptMessageToolNames(
                transcript,
                defaults.tools,
              ),
            ],
            max_tokens: maxOutputTokens,
            stream: true,
            tools: translatedTools,
            tool_choice: translateResponsesToolChoiceToChatWithTools(
              defaults.tools,
              defaults.tool_choice,
            ),
          },
          proxyContext,
          debugTrace,
          '/v1/responses',
          {
            emitStreamEvents: true,
            onCall: (invocation) => {
              const outputIndex = allocateOutputIndex();
              const id = `ws_${crypto.randomUUID().replaceAll('-', '')}`;
              const item = {
                completed: buildResponsesWebSearchCallItem(
                  invocation,
                  'completed',
                  id,
                ),
                inProgress: buildResponsesWebSearchCallItem(
                  invocation,
                  'in_progress',
                  id,
                ),
                outputIndex,
              };
              serverToolItems.push(item);
              itemsByInvocationId.set(invocation.id, item);
              enqueueEvent({
                type: 'response.output_item.added',
                item: item.inProgress,
                output_index: outputIndex,
                response_id: responseId,
              });
              enqueueEvent({
                type: 'response.web_search_call.in_progress',
                item_id: id,
                output_index: outputIndex,
              });
              enqueueEvent({
                type: 'response.web_search_call.searching',
                item_id: id,
                output_index: outputIndex,
              });
            },
            onResult: (execution) => {
              const item = itemsByInvocationId.get(execution.id)!;
              const id = String(item.inProgress.id);
              item.completed = buildResponsesWebSearchCallItem(
                execution,
                'completed',
                id,
              );
              enqueueEvent({
                type: 'response.web_search_call.completed',
                item_id: id,
                output_index: item.outputIndex,
              });
              enqueueEvent({
                type: 'response.output_item.done',
                item: item.completed,
                output_index: item.outputIndex,
                response_id: responseId,
              });
            },
          },
        );

        if (cancelled) {
          await upstreamResponse.body?.cancel();
          return;
        }

        if (!upstreamResponse.ok || !upstreamResponse.body) {
          enqueueEvent({
            type: 'response.error',
            error: { message: 'Upstream request failed' },
          });
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
          return;
        }

        const mappedResponse = mapChatStreamToResponsesEventStream(
          upstreamResponse,
          defaults,
          transcript,
          model,
          previousResponseId,
          proxyContext,
          responseId,
          serverToolItems,
          false,
          false,
          allocateOutputIndex,
          true,
        );
        const reader = mappedResponse.body!.getReader();
        activeReader = reader;

        while (true) {
          const { done, value } = await reader.read();
          if (cancelled) return;
          if (done) break;
          controller.enqueue(value);
        }

        reader.releaseLock();
        activeReader = null;
        controller.close();
      };

      void run().catch((error) => {
        if (!cancelled) controller.error(error);
      });
    },
    async cancel(reason): Promise<void> {
      cancelled = true;
      await activeReader?.cancel(reason);
      activeReader?.releaseLock();
      activeReader = null;
    },
  });

  return new Response(stream, {
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
  debugTrace?: DebugTrace,
): Promise<Response> => {
  try {
    const previousResponseId = body.previous_response_id ?? null;
    const accessKey = await resolveRequestAccessKey(request);
    const storedPreviousSession = previousResponseId
      ? await getResponseSession(previousResponseId)
      : undefined;

    if (
      previousResponseId &&
      storedPreviousSession &&
      storedPreviousSession.accessKeyId !== (accessKey?.id ?? null)
    ) {
      throw new Error('Unknown or expired previous_response_id');
    }

    if (
      storedPreviousSession?.credentialFilename &&
      accessKey?.credentialFilenames?.length &&
      !accessKey.credentialFilenames.includes(
        storedPreviousSession.credentialFilename,
      )
    ) {
      throw new Error('Unknown or expired previous_response_id');
    }

    const resolvedProxyContext = storedPreviousSession?.credentialFilename
      ? await resolveProxyContextByCredentialFilename(
          storedPreviousSession.credentialFilename,
          {
            accessKey: accessKey
              ? {
                  id: accessKey.id,
                  name: accessKey.name,
                }
              : undefined,
            allowedCredentialFilenames: accessKey?.credentialFilenames,
            requireEligible: true,
          },
        )
      : await resolveProxyContext(
          request,
          typeof body.model === 'string' ? body.model : undefined,
        );
    const proxyContext = storedPreviousSession?.upstreamProtocol
      ? {
          ...resolvedProxyContext,
          preferences: {
            ...resolvedProxyContext.preferences,
            upstreamProtocol: storedPreviousSession.upstreamProtocol,
          },
        }
      : resolvedProxyContext;

    const scopedBody =
      typeof body.model !== 'string' || !body.model.trim()
        ? {
            ...body,
            model:
              storedPreviousSession?.model ??
              getCredentialSupportedModels(
                proxyContext.auth.credentialData,
              )[0] ??
              (await getDefaultModel()),
          }
        : body;

    if (proxyContext.preferences.upstreamProtocol === 'responses') {
      const model = String(
        (scopedBody as ResponsesRequestBody).model ?? 'unknown',
      );
      return proxyResponsesUpstream(
        request,
        scopedBody as Record<string, unknown>,
        proxyContext,
        debugTrace,
        async (responseId) => {
          await storeUpstreamResponseBinding({
            model,
            proxyContext,
            responseId,
          });
        },
      );
    }

    const previousSession = await getValidatedPreviousSession(
      previousResponseId,
      accessKey?.id ?? null,
    );

    const prepared = await prepareTranscript(
      scopedBody,
      proxyContext.accessKeyId,
      previousSession,
    );
    const compatibilityError = getResponsesCompatibilityError(
      prepared.defaults.tools,
      prepared.defaults.tool_choice,
    );

    if (compatibilityError) {
      return compatibilityError;
    }

    prepared.defaults.tools = prepared.defaults.tools;

    if (body.stream) {
      return await createResponsesEventStream(
        request,
        prepared.defaults,
        prepared.transcript,
        prepared.model,
        prepared.previousResponseId,
        body.max_output_tokens,
        proxyContext,
        debugTrace,
      );
    }

    const chatBody = {
      model: prepared.model,
      messages: [
        ...(prepared.defaults.instructions
          ? [{ role: 'system', content: prepared.defaults.instructions }]
          : []),
        ...normalizeTranscriptMessageToolNames(
          prepared.transcript,
          prepared.defaults.tools,
        ),
      ],
      max_tokens: body.max_output_tokens,
      stream: false,
      tools: translateResponsesToolsToChat(prepared.defaults.tools),
      tool_choice: translateResponsesToolChoiceToChatWithTools(
        prepared.defaults.tools,
        prepared.defaults.tool_choice,
      ),
    };

    // Image generation has no chat-protocol equivalent, so the model's call is
    // executed here and replayed with the image folded in. Only meaningful when
    // the tool was actually declared; otherwise the loop returns null and the
    // ordinary upstream call runs.
    if (hasImageGenerationTool(prepared.defaults.tools)) {
      const imageResponse = await executeImageGenerationLoop({
        body: chatBody,
        callUpstream: (loopBody) =>
          proxyChatCompletions(
            request,
            loopBody as never,
            proxyContext,
            debugTrace,
            '/v1/responses',
          ),
        context: proxyContext,
        request,
      });

      if (imageResponse) {
        if (!imageResponse.ok) {
          return imageResponse;
        }

        const imagePayload = (await imageResponse.json()) as Record<
          string,
          unknown
        >;

        return Response.json(
          await mapChatResponseToResponsesPayload(
            proxyContext.accessKeyId,
            proxyContext.credentialFilename,
            prepared.defaults,
            prepared.transcript,
            prepared.model,
            prepared.previousResponseId,
            imagePayload,
            getServerToolExecutions(imageResponse),
          ),
        );
      }
    }

    const upstreamResponse = await proxyChatCompletions(
      request,
      chatBody as never,
      proxyContext,
      debugTrace,
      '/v1/responses',
    );

    if (!upstreamResponse.ok) {
      return upstreamResponse;
    }

    const upstreamPayload = (await upstreamResponse.json()) as Record<
      string,
      unknown
    >;
    const serverToolExecutions = getServerToolExecutions(upstreamResponse);

    return Response.json(
      await mapChatResponseToResponsesPayload(
        proxyContext.accessKeyId,
        proxyContext.credentialFilename,
        prepared.defaults,
        prepared.transcript,
        prepared.model,
        prepared.previousResponseId,
        upstreamPayload,
        serverToolExecutions,
      ),
    );
  } catch (error) {
    console.error('[CodeBuddy2API] Responses request failed', {
      route: '/v1/responses',
      error,
    });
    return createErrorResponse(
      error instanceof Error && error.message.includes('previous_response_id')
        ? 400
        : error instanceof Error &&
            error.message.includes('Response session exceeds')
          ? 413
          : 500,
      error instanceof Error ? error.message : 'Unexpected responses error',
    );
  }
};

export const resetResponseSessions = (): void => {
  getSessionStore().clear();
  getSessionByteStore().clear();
  setSessionTotalBytes(0);
};
