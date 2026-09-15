import {
  getJsonBody,
  readJsonBodyOrErrorResponse,
  readJsonBodyOrFailure,
  RequestBodyTooLargeError,
} from '@/lib/server/shared/http';

const makeRequest = (
  body: BodyInit | null,
  headers: Record<string, string> = {},
): Request =>
  new Request('http://localhost/v1/responses', {
    body,
    headers: { 'Content-Type': 'application/json', ...headers },
    method: 'POST',
  });

/**
 * A chunked request: no Content-Length, so the size cap has to be enforced
 * while the bytes arrive rather than from the header.
 */
const makeChunkedRequest = (chunks: Uint8Array[]): Request => {
  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      chunks.forEach((chunk) => controller.enqueue(chunk));
      controller.close();
    },
  });

  return new Request('http://localhost/v1/responses', {
    body: stream,
    duplex: 'half',
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
    // Node's undici accepts a stream body in half-duplex mode; the DOM
    // RequestInit type does not model `duplex`, so cast past the gap.
  } as unknown as RequestInit);
};

describe('request body limits', () => {
  it('parses a body that is within the cap', async () => {
    await expect(
      getJsonBody<{ input: string }>(
        makeRequest(JSON.stringify({ input: 'hello' })),
      ),
    ).resolves.toEqual({ input: 'hello' });
  });

  it('rejects an oversized body from Content-Length without reading it', async () => {
    // The header claims 2x the cap; the body itself is tiny, so only the
    // declared length can be what triggers the rejection.
    const request = makeRequest(JSON.stringify({ input: 'small' }), {
      'Content-Length': String(16 * 1024 * 1024),
    });

    await expect(getJsonBody(request)).rejects.toBeInstanceOf(
      RequestBodyTooLargeError,
    );
  });

  it('rejects a chunked body that crosses the cap mid-stream', async () => {
    // No Content-Length: the limit must be enforced as bytes arrive, which is
    // the case a naive `request.text()` + post-check would miss.
    const chunk = new Uint8Array(1024 * 1024).fill(0x61);
    const request = makeChunkedRequest(Array.from({ length: 12 }, () => chunk));

    await expect(getJsonBody(request)).rejects.toBeInstanceOf(
      RequestBodyTooLargeError,
    );
  });

  it('reports the cap in the error message', async () => {
    const request = makeRequest(JSON.stringify({}), {
      'Content-Length': String(64 * 1024 * 1024),
    });

    await expect(getJsonBody(request)).rejects.toThrow(/8MB/);
  });

  it('ignores a non-numeric Content-Length', async () => {
    await expect(
      getJsonBody<{ ok: boolean }>(
        makeRequest(JSON.stringify({ ok: true }), {
          'Content-Length': 'not-a-number',
        }),
      ),
    ).resolves.toEqual({ ok: true });
  });

  it('parses a valid chunked body that stays under the cap', async () => {
    const encoder = new TextEncoder();
    const request = makeChunkedRequest([
      encoder.encode('{"in'),
      encoder.encode('put":"streamed"}'),
    ]);

    await expect(getJsonBody<{ input: string }>(request)).resolves.toEqual({
      input: 'streamed',
    });
  });

  it('handles a request with no body', async () => {
    await expect(
      getJsonBody(makeRequest(null)).catch((error: unknown) => error),
    ).resolves.toBeDefined();
  });

  it('converts an oversized body into a 413 response', async () => {
    const request = makeRequest(JSON.stringify({}), {
      'Content-Length': String(64 * 1024 * 1024),
    });

    const result = await readJsonBodyOrErrorResponse(request);

    expect('response' in result).toBe(true);

    if (!('response' in result)) {
      return;
    }

    expect(result.response.status).toBe(413);
    await expect(result.response.json()).resolves.toMatchObject({
      error: { detail: { limit_bytes: expect.any(Number) } },
    });
  });

  it('converts malformed JSON into a 400 response', async () => {
    const result = await readJsonBodyOrErrorResponse(makeRequest('{not json'));

    expect('response' in result).toBe(true);

    if (!('response' in result)) {
      return;
    }

    expect(result.response.status).toBe(400);
    await expect(result.response.json()).resolves.toMatchObject({
      error: { message: expect.stringContaining('valid JSON') },
    });
  });

  it('exposes the failure as a status/message pair for non-OpenAI routes', async () => {
    const tooLarge = await readJsonBodyOrFailure(
      makeRequest(JSON.stringify({}), {
        'Content-Length': String(64 * 1024 * 1024),
      }),
    );
    expect(tooLarge).toEqual({
      failure: { message: expect.stringContaining('8MB'), status: 413 },
    });

    const malformed = await readJsonBodyOrFailure(makeRequest('{not json'));
    expect(malformed).toEqual({
      failure: { message: 'Request body must be valid JSON', status: 400 },
    });
  });

  it('returns the parsed body when reading succeeds', async () => {
    const result = await readJsonBodyOrFailure<{ ok: boolean }>(
      makeRequest(JSON.stringify({ ok: true })),
    );

    expect(result).toEqual({ body: { ok: true } });
  });
});
