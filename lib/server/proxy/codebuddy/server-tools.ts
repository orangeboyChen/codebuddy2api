import {
  normalizeToolName,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
} from '../../search/tool';
import { aggregateUpstreamStream } from './chat-stream';
import { type ChatStreamChunk, type StreamProbeState } from './types';

export const isServerWebToolName = (name: string): boolean => {
  const normalized = normalizeToolName(name);

  return (
    normalized === normalizeToolName(WEB_SEARCH_TOOL_NAME) ||
    normalized === normalizeToolName(WEB_FETCH_TOOL_NAME)
  );
};

export const mergeToolName = (previous: string, incoming: string): string => {
  if (!previous || incoming.startsWith(previous)) {
    return incoming;
  }

  if (!incoming || previous.endsWith(incoming)) {
    return previous;
  }

  return previous + incoming;
};

export const classifyStreamFrame = (
  frame: string,
  state: StreamProbeState,
  serverToolNames: string[],
): 'passthrough' | 'server-tool' | null => {
  const line = frame
    .split('\n')
    .find((segment) => segment.startsWith('data: '));

  if (!line) {
    return null;
  }

  const raw = line.slice(6).trim();

  if (!raw || raw === '[DONE]') {
    return raw === '[DONE]' ? 'passthrough' : null;
  }

  try {
    const chunk = JSON.parse(raw) as ChatStreamChunk;

    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta;
      const toolCalls = delta?.tool_calls ?? [];
      let hasNonServerTool = false;

      for (const [position, toolCall] of toolCalls.entries()) {
        const incoming = toolCall.function?.name;

        if (typeof incoming !== 'string' || !incoming) {
          continue;
        }

        const key =
          typeof toolCall.index === 'number'
            ? `index:${toolCall.index}`
            : toolCall.id
              ? `id:${toolCall.id}`
              : `position:${position}`;
        const name = mergeToolName(state.toolNames.get(key) ?? '', incoming);
        const normalized = normalizeToolName(name);

        state.toolNames.set(key, name);

        if (isServerWebToolName(name) && serverToolNames.includes(normalized)) {
          return 'server-tool';
        }

        if (
          normalized &&
          !serverToolNames.some((serverName) =>
            serverName.startsWith(normalized),
          )
        ) {
          hasNonServerTool = true;
        }
      }

      if (
        delta?.content ||
        delta?.reasoning_content ||
        delta?.reasoning ||
        hasNonServerTool ||
        choice.finish_reason != null
      ) {
        return 'passthrough';
      }
    }
  } catch {
    return null;
  }

  return null;
};

export const concatenateChunks = (chunks: Uint8Array[]): ArrayBuffer => {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const combined = new Uint8Array(size);
  let offset = 0;

  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return combined.buffer;
};

export const createResponseWithBody = (
  body: BodyInit,
  response: Response,
): Response =>
  new Response(body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });

export const createReplayStreamResponse = ({
  chunks,
  reader,
  response,
}: {
  chunks: Uint8Array[];
  reader: ReadableStreamDefaultReader<Uint8Array>;
  response: Response;
}): Response => {
  let cancelled = false;

  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }

      const pump = async (): Promise<void> => {
        while (true) {
          const { done, value } = await reader.read();

          if (cancelled) {
            return;
          }

          if (done) {
            reader.releaseLock();
            controller.close();
            return;
          }

          controller.enqueue(value);
        }
      };

      void pump().catch((error) => {
        if (!cancelled) {
          controller.error(error);
        }
      });
    },
    async cancel(reason): Promise<void> {
      cancelled = true;
      try {
        await reader.cancel(reason);
      } finally {
        reader.releaseLock();
      }
    },
  });

  return createResponseWithBody(stream, response);
};

export const detectServerToolStream = async (
  response: Response,
  fallbackModel: string,
  serverToolNames: string[],
): Promise<Response> => {
  if (!response.body) {
    return response;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: Uint8Array[] = [];
  const state: StreamProbeState = { toolNames: new Map() };
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      reader.releaseLock();
      return createResponseWithBody(concatenateChunks(chunks), response);
    }

    chunks.push(value);
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';

    for (const frame of frames) {
      const classification = classifyStreamFrame(frame, state, serverToolNames);

      if (classification === 'passthrough') {
        return createReplayStreamResponse({ chunks, reader, response });
      }

      if (classification === 'server-tool') {
        while (true) {
          const remainder = await reader.read();

          if (remainder.done) {
            reader.releaseLock();
            break;
          }

          chunks.push(remainder.value);
        }

        return (
          await aggregateUpstreamStream(
            new Response(concatenateChunks(chunks)),
            fallbackModel,
          )
        ).response;
      }
    }
  }
};
