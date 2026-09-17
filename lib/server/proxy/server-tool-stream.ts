import { isLocalServerToolCall } from './server-tool-classify';
import type {
  ChatCompletionMessage,
  ChatCompletionToolCall,
} from './server-tool-types';
import type { WebFetchProvider, WebSearchProvider } from '../search/types';

export const mergeStreamingToolName = (
  previous: string,
  incoming: string,
): string => {
  if (!previous || incoming.startsWith(previous)) return incoming;
  if (!incoming || previous.endsWith(incoming)) return previous;
  return previous + incoming;
};

export const aggregateStreamingToolCalls = (
  deltas: ChatCompletionToolCall[],
): ChatCompletionToolCall[] => {
  const calls = new Map<
    string,
    ChatCompletionToolCall & {
      function: { arguments: string; name: string };
    }
  >();
  const latestKeyByIndex = new Map<number, string>();

  deltas.forEach((delta, position) => {
    const indexedKey =
      typeof delta.index === 'number'
        ? latestKeyByIndex.get(delta.index)
        : undefined;
    const key =
      indexedKey ??
      (delta.id ? `id:${delta.id}` : undefined) ??
      (typeof delta.index === 'number'
        ? `index:${delta.index}`
        : `position:${position}`);
    const current = calls.get(key) ?? {
      function: { arguments: '', name: '' },
      index: delta.index,
    };

    current.id = delta.id ?? current.id;
    current.index = delta.index ?? current.index;
    current.type = delta.type ?? current.type;
    current.function.arguments += delta.function?.arguments ?? '';
    current.function.name = mergeStreamingToolName(
      current.function.name,
      delta.function?.name ?? '',
    );
    calls.set(key, current);

    if (typeof delta.index === 'number') {
      latestKeyByIndex.set(delta.index, key);
    }
  });

  return [...calls.values()];
};

/**
 * Result of streaming one upstream response while watching for server-tool
 * calls, so a follow-up iteration can decide what happened.
 *
 * `localCalls` and `remainingCalls` partition the aggregated tool calls the
 * way the execution loop needs them; `frames` are the frames that were held
 * back because they carried tool-call deltas.
 */
export interface ServerToolProbe {
  content: string;
  frames: string[];
  localCalls: ChatCompletionToolCall[];
  reasoning: string;
  remainingCalls: ChatCompletionToolCall[];
  role: string;
  toolCalls: ChatCompletionToolCall[];
  usage: unknown;
}

export const probeServerToolStream = async ({
  canContinue,
  context,
  emitRaw,
  fetchProvider,
  onReader,
  ownedNames,
  response,
  searchProvider,
}: {
  canContinue: () => boolean;
  context: {
    responseCreated: number;
    responseId: string;
    responseModel: string;
    responseObject: string;
    role: string;
    usage: unknown;
  };
  emitRaw: (frame: string) => void;
  fetchProvider: WebFetchProvider | null;
  ownedNames?: Set<string>;
  /**
   * Hands the active reader to the caller's cancellation path. Without it a
   * disconnect cannot interrupt a read that is already parked: the loop only
   * notices the cancellation once upstream produces another chunk, which a
   * stalled upstream never does.
   */
  onReader?: (reader: ReadableStreamDefaultReader<Uint8Array> | null) => void;
  response: Response;
  searchProvider: WebSearchProvider | null;
}): Promise<ServerToolProbe> => {
  const frames: string[] = [];
  const toolCallDeltas: ChatCompletionToolCall[] = [];
  const decoder = new TextDecoder();
  const reader = response.body!.getReader();
  onReader?.(reader);
  let buffer = '';
  let content = '';
  let reasoning = '';

  const inspectFrame = (frame: string): void => {
    const line = frame
      .split(/\r?\n/)
      .find((segment) => segment.startsWith('data:'));

    if (!line) {
      emitRaw(frame);
      return;
    }

    const raw = line.slice(5).trim();
    if (!raw) return;
    if (raw === '[DONE]') {
      frames.push(frame);
      return;
    }

    try {
      const chunk = JSON.parse(raw) as {
        choices?: Array<{
          delta?: ChatCompletionMessage & {
            tool_calls?: ChatCompletionToolCall[];
          };
          finish_reason?: string | null;
        }>;
        created?: number;
        id?: string;
        model?: string;
        object?: string;
        usage?: unknown;
      };
      context.responseId = chunk.id ?? context.responseId;
      context.responseModel = chunk.model ?? context.responseModel;
      context.responseObject =
        chunk.object?.replace(/\.chunk$/, '') ?? context.responseObject;
      context.responseCreated = chunk.created ?? context.responseCreated;
      context.usage = chunk.usage ?? context.usage;
      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      context.role = delta?.role ?? context.role;
      content += delta?.content ?? '';
      reasoning += delta?.reasoning_content ?? delta?.reasoning ?? '';

      // A tool-call frame is held rather than forwarded: if the turn turns out
      // to invoke a server tool, the call has to be answered locally instead
      // of being handed to the client as an unresolved call. Anything else the
      // delta carried — most importantly the text the model wrote before
      // deciding to search — still belongs to the visible turn, so it is
      // re-emitted without the tool call.
      if (delta?.tool_calls?.length) {
        toolCallDeltas.push(...delta.tool_calls);
        frames.push(frame);

        const visibleDelta = { ...delta };
        delete visibleDelta.tool_calls;

        if (Object.keys(visibleDelta).length) {
          const visible = JSON.stringify({
            ...chunk,
            choices: [{ ...choice, delta: visibleDelta, finish_reason: null }],
          });
          emitRaw(`data: ${visible}`);
        }
        return;
      }

      if (choice?.finish_reason === 'tool_calls') {
        frames.push(frame);
        return;
      }
    } catch {
      emitRaw(frame);
      return;
    }

    emitRaw(frame);
  };

  while (true) {
    const chunk = await reader.read();
    if (!canContinue()) break;
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const split = buffer.split(/\r?\n\r?\n/);
    buffer = split.pop() ?? '';
    split.forEach(inspectFrame);
  }

  if (buffer.trim()) inspectFrame(buffer);
  reader.releaseLock();
  onReader?.(null);

  const toolCalls = aggregateStreamingToolCalls(toolCallDeltas);
  const isLocalCall = (toolCall: ChatCompletionToolCall): boolean =>
    isLocalServerToolCall({
      fetchProvider,
      ownedNames,
      searchProvider,
      toolCall,
    });

  return {
    content,
    frames,
    localCalls: toolCalls.filter(isLocalCall),
    reasoning,
    remainingCalls: toolCalls.filter((toolCall) => !isLocalCall(toolCall)),
    role: context.role,
    toolCalls,
    usage: context.usage,
  };
};
