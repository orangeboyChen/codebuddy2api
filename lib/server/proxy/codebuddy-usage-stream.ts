import {
  createStreamCloser,
  responsesStreamErrorChunks,
  toUpstreamTimeoutMessage,
} from '../shared/upstream-timeout';
import {
  extractResponsesId,
  extractResponsesUsage,
  recordProxyUsage,
} from './codebuddy-usage';
import { MAX_STREAM_FRAME_LENGTH, type ProxyContext } from './codebuddy-types';

export const trackResponsesUsageStream = async ({
  fallbackUsage,
  model,
  onResponseId,
  proxyContext,
  upstreamResponse,
}: {
  fallbackUsage: unknown;
  model: string;
  onResponseId?: (responseId: string) => Promise<void>;
  proxyContext: ProxyContext;
  upstreamResponse: Response;
}): Promise<Response> => {
  if (!upstreamResponse.body) {
    await recordProxyUsage({
      model,
      proxyContext,
      route: '/v1/responses',
      usage: fallbackUsage,
    });

    return new Response(null, {
      headers: upstreamResponse.headers,
      status: upstreamResponse.status,
    });
  }

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let cancelled = false;
  const closer = createStreamCloser();
  let latestUsage = fallbackUsage;
  let responseBinding: Promise<void> | null = null;
  let usageRecorded = false;
  const releaseReader = (): void => {
    reader?.releaseLock();
    reader = null;
  };
  const recordStreamUsage = async (): Promise<void> => {
    if (usageRecorded) return;
    usageRecorded = true;
    try {
      await recordProxyUsage({
        model,
        proxyContext,
        route: '/v1/responses',
        usage: latestUsage,
      });
    } catch (error) {
      console.error('[CodeBuddy2API] Failed to record Responses stream usage', {
        error,
        route: '/v1/responses',
      });
    }
  };
  const bindResponseId = (id: string): Promise<void> => {
    if (!onResponseId) return Promise.resolve();
    responseBinding ??= onResponseId(id).catch((error) => {
      console.error(
        '[CodeBuddy2API] Failed to bind upstream Responses session',
        {
          error,
          responseId: id,
        },
      );
    });
    return responseBinding;
  };
  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      const upstreamReader = upstreamResponse.body!.getReader();
      reader = upstreamReader;
      let buffer = '';
      let responseId: string | null = null;

      const inspectFrame = async (frame: string): Promise<void> => {
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) {
            continue;
          }

          const raw = line.slice(5).trim();

          if (!raw || raw === '[DONE]') {
            continue;
          }

          try {
            const event = JSON.parse(raw) as unknown;
            latestUsage = extractResponsesUsage(event) ?? latestUsage;
            responseId = extractResponsesId(event) ?? responseId;
            if (responseId) await bindResponseId(responseId);
          } catch {
            // Preserve malformed upstream frames without recording them.
          }
        }
      };

      const pump = async (): Promise<void> => {
        while (true) {
          const { done, value } = await upstreamReader.read();

          if (cancelled) {
            return;
          }

          if (done) {
            if (buffer) {
              await inspectFrame(buffer);
              if (closer.closed) return;
              controller.enqueue(encoder.encode(buffer));
            }

            await recordStreamUsage();
            await responseBinding;
            releaseReader();
            closer.mark();
            controller.close();
            return;
          }

          const text = decoder.decode(value, { stream: true });
          buffer += text;
          const frames = buffer.split('\n\n');
          buffer = frames.pop()!;
          if (buffer.length > MAX_STREAM_FRAME_LENGTH) {
            buffer = '';
          }

          for (const frame of frames) {
            if (frame.length > MAX_STREAM_FRAME_LENGTH) {
              continue;
            }
            await inspectFrame(frame);
            if (cancelled) return;
            controller.enqueue(encoder.encode(`${frame}\n\n`));
          }
        }
      };

      void pump().catch(async (error) => {
        if (cancelled) return;
        console.error('[CodeBuddy2API] Responses upstream stream failed', {
          error,
          route: '/v1/responses',
        });
        await responseBinding;
        await recordStreamUsage();
        releaseReader();
        const timeoutMessage = toUpstreamTimeoutMessage(error);

        if (timeoutMessage !== null) {
          // Frames here are forwarded verbatim, so the error has to arrive as
          // the Responses protocol's own event.
          closer.fail(controller, responsesStreamErrorChunks(timeoutMessage));
          return;
        }

        controller.error(error);
      });
    },
    async cancel(reason): Promise<void> {
      cancelled = true;
      closer.mark();
      try {
        await reader?.cancel(reason);
      } finally {
        await responseBinding;
        await recordStreamUsage();
        releaseReader();
      }
    },
  });

  return new Response(stream, {
    headers: upstreamResponse.headers,
    status: upstreamResponse.status,
  });
};
