import { describe, expect, it, vi } from 'vitest';

import {
  anthropicStreamErrorChunks,
  chatStreamErrorChunks,
  createStreamCloser,
  createUpstreamDeadline,
  fetchWithDeadline,
  isUpstreamTimeoutError,
  isUpstreamTimeoutText,
  readTimeoutFrame,
  responsesStreamErrorChunks,
  toUpstreamTimeoutMessage,
  UpstreamTimeoutError,
} from '@/lib/server/shared/upstream-timeout';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * A response whose body yields the given chunks. With `hangAfter` the body
 * stays open afterwards, which is what an upstream that sends keepalives but
 * never produces output looks like; without it, the body closes so the test
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

/** A JSON response whose body stalls after the headers have been sent. */
const makeStalledJsonResponse = (): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"partial":'));
      },
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );

const readAll = async (
  response: Response,
): Promise<{ error: unknown; text: string }> => {
  const reader = response.body!.getReader();
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
    const timeout = new UpstreamTimeoutError(120_000, 'firstOutput');

    expect(isUpstreamTimeoutError(timeout)).toBe(true);
    expect(toUpstreamTimeoutMessage(timeout)).toContain(
      'did not produce output',
    );
    expect(toUpstreamTimeoutMessage(new Error('socket hang up'))).toBeNull();
    expect(toUpstreamTimeoutMessage(null)).toBeNull();
  });

  it('releases the deadline once output arrives', async () => {
    const deadline = createUpstreamDeadline(20);
    const upstream = makeEventStreamResponse([
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
    ]);
    const tracked = deadline.trackFirstOutput(upstream);

    const { error, text } = await readAll(tracked);

    expect(error).toBeNull();
    expect(text).toContain('"content":"hi"');
  });

  it('fails the stream when no output arrives within the deadline', async () => {
    const deadline = createUpstreamDeadline(10);
    // Keepalive comments only: the socket is alive but nothing was produced.
    const upstream = makeEventStreamResponse([': ping\n\n'], {
      hangAfter: true,
    });
    const tracked = deadline.trackFirstOutput(upstream);

    const { error } = await readAll(tracked);

    expect(error).toBeInstanceOf(UpstreamTimeoutError);
    expect((error as UpstreamTimeoutError).phase).toBe('firstOutput');
  });

  it('does not treat an empty data line or [DONE] as output', async () => {
    const deadline = createUpstreamDeadline(10);
    const upstream = makeEventStreamResponse(
      ['data: \n\n', 'data: [DONE]\n\n'],
      { hangAfter: true },
    );

    const { error } = await readAll(deadline.trackFirstOutput(upstream));

    expect(error).toBeInstanceOf(UpstreamTimeoutError);
  });

  it('does not treat Responses lifecycle events as output', async () => {
    // Native Responses streams open with created/in_progress/output_item.added
    // before the model emits anything. Releasing on those would leave a model
    // that stalls afterwards unguarded for the rest of the request.
    const deadline = createUpstreamDeadline(10);
    const upstream = makeEventStreamResponse(
      [
        'data: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
        'data: {"type":"response.in_progress","response":{"status":"in_progress"}}\n\n',
        'data: {"type":"response.output_item.added","item":{"id":"msg_1"}}\n\n',
      ],
      { hangAfter: true },
    );

    const { error } = await readAll(deadline.trackFirstOutput(upstream));

    expect(error).toBeInstanceOf(UpstreamTimeoutError);
  });

  it('treats a Responses output delta as output', async () => {
    const deadline = createUpstreamDeadline(20);
    const upstream = makeEventStreamResponse([
      'data: {"type":"response.created","response":{"id":"resp_1"}}\n\n',
      'data: {"type":"response.output_text.delta","delta":"hi"}\n\n',
    ]);

    const { error } = await readAll(deadline.trackFirstOutput(upstream));

    expect(error).toBeNull();
  });

  it('treats a Responses tool-call argument delta as output', async () => {
    const deadline = createUpstreamDeadline(20);
    const upstream = makeEventStreamResponse([
      'data: {"type":"response.function_call_arguments.delta","delta":"{}"}\n\n',
    ]);

    const { error } = await readAll(deadline.trackFirstOutput(upstream));

    expect(error).toBeNull();
  });

  it('ignores a chat chunk whose choice carries no delta', async () => {
    // Malformed or empty choices must not be mistaken for output.
    const deadline = createUpstreamDeadline(10);
    const upstream = makeEventStreamResponse(
      ['data: {"choices":[{}]}\n\n', 'data: {"choices":[{"delta":null}]}\n\n'],
      { hangAfter: true },
    );

    const { error } = await readAll(deadline.trackFirstOutput(upstream));

    expect(error).toBeInstanceOf(UpstreamTimeoutError);
  });

  it('ignores a payload with no choices array', async () => {
    const deadline = createUpstreamDeadline(10);
    const upstream = makeEventStreamResponse(
      ['data: {"type":"response.created","response":{"id":"r1"}}\n\n'],
      { hangAfter: true },
    );

    const { error } = await readAll(deadline.trackFirstOutput(upstream));

    expect(error).toBeInstanceOf(UpstreamTimeoutError);
  });

  it('does not treat a role-only chat chunk as output', async () => {
    const deadline = createUpstreamDeadline(10);
    // The first chat chunk usually carries only the assistant role, which is
    // a lifecycle frame rather than something the user can see.
    const upstream = makeEventStreamResponse(
      ['data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n'],
      { hangAfter: true },
    );

    const { error } = await readAll(deadline.trackFirstOutput(upstream));

    expect(error).toBeInstanceOf(UpstreamTimeoutError);
  });

  it('treats reasoning and tool-call chunks as output', async () => {
    const deadline = createUpstreamDeadline(20);

    const reasoning = await readAll(
      createUpstreamDeadline(20).trackFirstOutput(
        makeEventStreamResponse([
          'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n',
        ]),
      ),
    );
    expect(reasoning.error).toBeNull();

    const toolCalls = await readAll(
      createUpstreamDeadline(20).trackFirstOutput(
        makeEventStreamResponse([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0}]}}]}\n\n',
        ]),
      ),
    );
    expect(toolCalls.error).toBeNull();

    expect(deadline.timeoutMs).toBe(20);
  });

  it('treats an unparseable payload as output rather than killing the stream', async () => {
    // An unfamiliar frame is more likely a healthy upstream than a stalled one,
    // so giving it the benefit of the doubt is the safer failure mode.
    const deadline = createUpstreamDeadline(20);
    const upstream = makeEventStreamResponse(['data: not-json\n\n']);

    const { error } = await readAll(deadline.trackFirstOutput(upstream));

    expect(error).toBeNull();
  });

  it('cancels the upstream reader when the streaming deadline fires', async () => {
    const deadline = createUpstreamDeadline(10);
    const upstream = makeEventStreamResponse([': ping\n\n'], {
      hangAfter: true,
    });
    const tracked = deadline.trackFirstOutput(upstream);

    await readAll(tracked);

    expect((upstream as unknown as { cancelled: boolean }).cancelled).toBe(
      true,
    );
  });

  it('releases the deadline once a non-streaming body starts arriving', async () => {
    // Headers alone must not release the deadline: a stalled JSON body would
    // then wait forever, which is the common partial-response failure mode.
    const deadline = createUpstreamDeadline(20);
    const upstream = makeStalledJsonResponse();
    const tracked = deadline.trackFirstOutput(upstream);
    const reader = tracked.body!.getReader();

    // The first chunk is proof the upstream started answering.
    const first = await reader.read();

    expect(decoder.decode(first.value)).toBe('{"partial":');
    await reader.cancel();
  });

  it('fails a non-streaming body that never delivers its first byte', async () => {
    const deadline = createUpstreamDeadline(10);
    const upstream = new Response(
      new ReadableStream<Uint8Array>({
        start() {
          // Headers are already sent, but no chunk ever arrives.
        },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );

    const { error } = await readAll(deadline.trackFirstOutput(upstream));

    expect(error).toBeInstanceOf(UpstreamTimeoutError);
  });

  it('passes through a response with no body', async () => {
    const deadline = createUpstreamDeadline(10);
    const upstream = new Response(null, {
      headers: { 'Content-Type': 'text/event-stream' },
    });

    const tracked = deadline.trackFirstOutput(upstream);

    expect(tracked.body).toBeNull();
  });

  it('preserves status and headers on a tracked response', () => {
    const deadline = createUpstreamDeadline(10);
    const upstream = new Response('data: {}\n\n', {
      headers: { 'Content-Type': 'text/event-stream', 'X-Trace': 'abc' },
      status: 201,
    });

    const tracked = deadline.trackFirstOutput(upstream);

    expect(tracked.status).toBe(201);
    expect(tracked.headers.get('X-Trace')).toBe('abc');
  });

  it('detects output split across chunk boundaries', async () => {
    const deadline = createUpstreamDeadline(10);
    // The `data:` payload is broken mid-line, so it only becomes visible once
    // the carry is joined with the next chunk.
    const upstream = makeEventStreamResponse([
      'data: {"choices":[{"delta":{"content":"a',
      'b"}}]}\n\n',
    ]);

    const { error } = await readAll(deadline.trackFirstOutput(upstream));

    expect(error).toBeNull();
  });

  it('honours a deadline that expired before tracking started', async () => {
    const deadline = createUpstreamDeadline(5);
    // Let the timer fire and set `settled` before any response exists.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const upstream = makeEventStreamResponse([
      'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
    ]);

    const { error } = await readAll(deadline.trackFirstOutput(upstream));

    expect(error).toBeInstanceOf(UpstreamTimeoutError);
  });
});

describe('fetchWithDeadline', () => {
  it('returns a 504 and reports the timeout when the upstream stalls', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(init.signal?.reason);
          });
        }),
    );

    const timeouts: string[] = [];
    const result = await fetchWithDeadline({
      body: '{}',
      headers: { 'Content-Type': 'application/json' },
      onTimeout: (error) => timeouts.push(error.message),
      timeoutMs: 10,
      url: 'http://upstream.test/v1/chat',
    });

    expect(result.ok).toBe(false);
    expect(result.response.status).toBe(504);
    await expect(result.response.json()).resolves.toMatchObject({
      error: { message: 'Upstream CodeBuddy request timed out' },
    });
    expect(timeouts).toHaveLength(1);
  });

  it('passes the response through when the upstream answers in time', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await fetchWithDeadline({
      body: '{}',
      headers: { 'Content-Type': 'application/json' },
      timeoutMs: 1000,
      url: 'http://upstream.test/v1/chat',
    });

    expect(result.ok).toBe(true);
    await expect(result.response.json()).resolves.toEqual({ ok: true });
  });

  it('rethrows a non-timeout upstream failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error('socket hang up'),
    );

    await expect(
      fetchWithDeadline({
        body: '{}',
        headers: { 'Content-Type': 'application/json' },
        timeoutMs: 1000,
        url: 'http://upstream.test/v1/chat',
      }),
    ).rejects.toThrow('socket hang up');
  });
});

describe('readTimeoutFrame', () => {
  const chatFrame = (message: string) =>
    `data: ${JSON.stringify({ error: { message } })}\n\n`;

  it('reads a deadline message out of a chat error frame', () => {
    const message = 'Upstream did not produce output within 6s';

    expect(readTimeoutFrame(chatFrame(message))).toBe(message);
    expect(isUpstreamTimeoutText(message)).toBe(true);
  });

  it('reads a deadline out of an Anthropic error event', () => {
    const message = 'Upstream did not produce output within 6s';
    const frame = `event: error\ndata: ${JSON.stringify({
      type: 'error',
      error: { type: 'api_error', message },
    })}\n\n`;

    expect(readTimeoutFrame(frame)).toBe(message);
  });

  it('ignores an error frame that is not a deadline', () => {
    // Oversized SSE frames are already surfaced by the wrapping mapper, so
    // mistaking them for a timeout would misreport an unrelated failure.
    expect(
      readTimeoutFrame(
        chatFrame('Upstream SSE frame exceeds the maximum size'),
      ),
    ).toBeNull();
    expect(isUpstreamTimeoutText('Upstream SSE frame exceeds')).toBe(false);
    expect(isUpstreamTimeoutText(42)).toBe(false);
  });

  it('ignores frames that carry no error', () => {
    expect(
      readTimeoutFrame('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'),
    ).toBeNull();
    expect(readTimeoutFrame('data: [DONE]\n\n')).toBeNull();
    expect(readTimeoutFrame(': ping\n\n')).toBeNull();
    expect(
      readTimeoutFrame('event: response.created\ndata: {}\n\n'),
    ).toBeNull();
  });
});

describe('terminal stream errors', () => {
  const drain = async (chunks: Uint8Array[]): Promise<string> => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        chunks.forEach((chunk) => controller.enqueue(chunk));
        controller.close();
      },
    });

    return (await readAll(new Response(stream))).text;
  };

  it('emits an OpenAI error chunk then [DONE]', async () => {
    const text = await drain(chatStreamErrorChunks('too slow'));

    expect(text).toContain('"error":{"message":"too slow"}');
    expect(text).toContain('data: [DONE]');
  });

  it('emits a Responses error event then [DONE]', async () => {
    const text = await drain(responsesStreamErrorChunks('too slow'));

    expect(text).toContain('event: response.error');
    expect(text).toContain('"type":"response.error"');
    expect(text).toContain('data: [DONE]');
  });

  it('emits an Anthropic api_error so clients treat it as retryable', async () => {
    const text = await drain(anthropicStreamErrorChunks('too slow'));

    expect(text).toContain('event: error');
    expect(text).toContain('"type":"api_error"');
  });
});

describe('createStreamCloser', () => {
  const collect = async (
    run: (
      controller: ReadableStreamDefaultController<Uint8Array>,
      closer: ReturnType<typeof createStreamCloser>,
    ) => void,
  ): Promise<{ closed: boolean; text: string }> => {
    const closer = createStreamCloser();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        run(controller, closer);
      },
    });
    const { text } = await readAll(new Response(stream));

    return { closed: closer.closed, text };
  };

  it('writes the chunks and closes once', async () => {
    const { closed, text } = await collect((controller, closer) => {
      closer.fail(controller, chatStreamErrorChunks('too slow'));
    });

    expect(closed).toBe(true);
    expect(text).toContain('too slow');
    expect(text).toContain('data: [DONE]');
  });

  it('is a no-op once already closed', async () => {
    const { text } = await collect((controller, closer) => {
      closer.mark();
      closer.fail(controller, chatStreamErrorChunks('too slow'));
      controller.close();
    });

    expect(text).toBe('');
  });

  it('does not throw when the consumer already cancelled', async () => {
    const closer = createStreamCloser();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(inner) {
        controller = inner;
      },
    });
    const reader = stream.getReader();

    await reader.cancel('client gone');

    // Writing to a cancelled controller throws; the closer has to absorb it
    // rather than letting it escape as an unhandled rejection.
    expect(() =>
      closer.fail(controller, chatStreamErrorChunks('too slow')),
    ).not.toThrow();
    expect(closer.closed).toBe(false);
  });
});
