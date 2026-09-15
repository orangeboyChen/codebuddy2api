import { describe, expect, it } from 'vitest';

import {
  createUpstreamDeadline,
  isUpstreamTimeoutError,
  toUpstreamTimeoutMessage,
  UpstreamTimeoutError,
} from '@/lib/server/shared/upstream-timeout';

const encoder = new TextEncoder();

/**
 * A response whose body yields the given chunks. With `hangAfter` the body
 * stays open afterwards, which is what an upstream that sends keepalives but
 * never produces a delta looks like; without it, the body closes so the test
 * can drain to completion.
 */
const makeEventStreamResponse = (
  chunks: string[],
  options: { hangAfter?: boolean } = {},
): Response => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
      if (!options.hangAfter) controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });

  // Exposed for assertions on whether the upstream was released.
  const response = new Response(body, {
    headers: { 'Content-Type': 'text/event-stream' },
  });

  Object.defineProperty(response, 'cancelled', {
    get: () => cancelled,
  });

  return response;
};

const readAll = async (
  response: Response,
): Promise<{ error: unknown; text: string }> => {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      text += decoder.decode(value, { stream: true });
    }

    return { error: null, text };
  } catch (error) {
    return { error, text };
  }
};

describe('createUpstreamDeadline', () => {
  it('aborts an in-flight request when the deadline passes before a response', async () => {
    const deadline = createUpstreamDeadline(10);
    const request = new Request('http://upstream.test/v1/chat', {
      method: 'POST',
      signal: deadline.signal,
    });

    // Stand in for `fetch`: a promise that only settles on abort.
    const pending = new Promise<Response>((_, reject) => {
      request.signal.addEventListener('abort', () => {
        reject(request.signal.reason);
      });
    });

    await expect(pending).rejects.toBeInstanceOf(UpstreamTimeoutError);
    await expect(pending).rejects.toMatchObject({ phase: 'response' });
  });

  it('reports a timeout message through toUpstreamTimeoutMessage', () => {
    const timeout = new UpstreamTimeoutError(120_000, 'firstDelta');

    expect(isUpstreamTimeoutError(timeout)).toBe(true);
    expect(toUpstreamTimeoutMessage(timeout)).toContain('first delta');
    expect(toUpstreamTimeoutMessage(new Error('socket hang up'))).toBeNull();
    expect(toUpstreamTimeoutMessage(null)).toBeNull();
  });

  it('releases the deadline once the first delta arrives', async () => {
    const deadline = createUpstreamDeadline(20);
    // Body closes after the delta, so the read terminates on its own.
    const upstream = makeEventStreamResponse([
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
    ]);
    const tracked = deadline.trackFirstDelta(upstream);

    const { error, text } = await readAll(tracked);

    expect(error).toBeNull();
    expect(text).toContain('"content":"hi"');
  });

  it('fails the stream when no delta arrives within the deadline', async () => {
    const deadline = createUpstreamDeadline(10);
    // Keepalive comments only: the socket is alive but nothing was produced.
    const upstream = makeEventStreamResponse([': ping\n\n'], {
      hangAfter: true,
    });
    const tracked = deadline.trackFirstDelta(upstream);

    const { error } = await readAll(tracked);

    expect(error).toBeInstanceOf(UpstreamTimeoutError);
    expect((error as UpstreamTimeoutError).phase).toBe('firstDelta');
  });

  it('does not treat an empty data line or [DONE] as a delta', async () => {
    const deadline = createUpstreamDeadline(10);
    const upstream = makeEventStreamResponse(
      ['data: \n\n', 'data: [DONE]\n\n'],
      { hangAfter: true },
    );

    const { error } = await readAll(deadline.trackFirstDelta(upstream));

    expect(error).toBeInstanceOf(UpstreamTimeoutError);
  });

  it('cancels the upstream reader when the streaming deadline fires', async () => {
    const deadline = createUpstreamDeadline(10);
    const upstream = makeEventStreamResponse([': ping\n\n'], {
      hangAfter: true,
    });
    const tracked = deadline.trackFirstDelta(upstream);

    await readAll(tracked);

    expect((upstream as unknown as { cancelled: boolean }).cancelled).toBe(
      true,
    );
  });

  it('releases the deadline for a non-streaming response', async () => {
    const deadline = createUpstreamDeadline(10);
    const upstream = new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
    const tracked = deadline.trackFirstDelta(upstream);

    // A JSON body has no delta to wait for, so it must pass through untouched
    // and stay readable regardless of the deadline.
    await expect(tracked.json()).resolves.toEqual({ ok: true });
  });

  it('passes through a response with no body', async () => {
    const deadline = createUpstreamDeadline(10);
    const upstream = new Response(null, {
      headers: { 'Content-Type': 'text/event-stream' },
    });

    const tracked = deadline.trackFirstDelta(upstream);

    expect(tracked.body).toBeNull();
  });

  it('preserves status and headers on a tracked response', () => {
    const deadline = createUpstreamDeadline(10);
    const upstream = new Response('data: {}\n\n', {
      headers: { 'Content-Type': 'text/event-stream', 'X-Trace': 'abc' },
      status: 201,
    });

    const tracked = deadline.trackFirstDelta(upstream);

    expect(tracked.status).toBe(201);
    expect(tracked.headers.get('X-Trace')).toBe('abc');
  });

  it('detects a delta split across chunk boundaries', async () => {
    const deadline = createUpstreamDeadline(10);
    // The `data:` payload is broken mid-line, so it only becomes visible once
    // the carry is joined with the next chunk.
    const upstream = makeEventStreamResponse(['data: {"delta":"a', 'b"}\n\n']);
    const tracked = deadline.trackFirstDelta(upstream);

    const { error } = await readAll(tracked);

    expect(error).toBeNull();
  });

  it('honours a deadline that expired before tracking started', async () => {
    const deadline = createUpstreamDeadline(5);
    // Let the timer fire and set `settled` before any response exists.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const upstream = makeEventStreamResponse(['data: {"delta":"x"}\n\n'], {
      hangAfter: true,
    });

    const { error } = await readAll(deadline.trackFirstDelta(upstream));

    expect(error).toBeInstanceOf(UpstreamTimeoutError);
  });
});
