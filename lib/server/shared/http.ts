/**
 * Ceiling on a proxied JSON request body. `request.json()` buffers and parses
 * the whole payload before any check is possible, and the parsed form is
 * typically several times larger than the raw bytes, so an oversized body has
 * to be rejected before parsing rather than after.
 */
const MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;

export class RequestBodyTooLargeError extends Error {
  readonly limitBytes: number;

  constructor(limitBytes: number) {
    super(
      `Request body exceeds the maximum size of ${Math.floor(limitBytes / (1024 * 1024))}MB`,
    );
    this.name = 'RequestBodyTooLargeError';
    this.limitBytes = limitBytes;
  }
}

const getDeclaredBodyBytes = (request: Request): number | null => {
  const contentLength = request.headers.get('content-length');

  if (!contentLength) {
    return null;
  }

  const parsed = Number.parseInt(contentLength, 10);

  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

/**
 * Reads the body while enforcing `MAX_REQUEST_BODY_BYTES`. A chunked request
 * declares no Content-Length, so the limit has to be applied as the bytes
 * arrive; buffering the whole body first would let an arbitrarily large
 * payload exhaust the heap before it could ever be rejected. The stream is
 * cancelled as soon as the cap is passed so the connection stops being fed.
 */
const readCappedText = async (request: Request): Promise<string> => {
  const body = request.body;

  if (!body) {
    return request.text();
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      totalBytes += value.byteLength;

      if (totalBytes > MAX_REQUEST_BODY_BYTES) {
        throw new RequestBodyTooLargeError(MAX_REQUEST_BODY_BYTES);
      }

      chunks.push(decoder.decode(value, { stream: true }));
    }

    chunks.push(decoder.decode());
  } finally {
    // Cancel rather than just releasing, so a rejected body stops the client
    // from pushing the remainder through a connection nobody will read.
    try {
      await reader.cancel();
    } catch {
      // The stream may already be closed or errored.
    } finally {
      reader.releaseLock();
    }
  }

  return chunks.join('');
};

export const getJsonBody = async <T>(request: Request): Promise<T> => {
  const declaredBytes = getDeclaredBodyBytes(request);

  // Cheap fast path: reject a body that declares itself oversized without
  // reading any of it.
  if (declaredBytes !== null && declaredBytes > MAX_REQUEST_BODY_BYTES) {
    throw new RequestBodyTooLargeError(MAX_REQUEST_BODY_BYTES);
  }

  const text = await readCappedText(request);

  return JSON.parse(text) as T;
};

/**
 * Reads and parses the body, reporting a malformed or oversized body as a
 * `(status, message)` pair instead of throwing. Callers turn that into
 * whichever error shape their API contract uses, so the Anthropic route can
 * stay on `type: "error"` while the OpenAI-compatible routes keep
 * `{ error: { message } }`.
 */
export const readJsonBodyOrFailure = async <T>(
  request: Request,
): Promise<{ body: T } | { failure: { message: string; status: number } }> => {
  try {
    return { body: await getJsonBody<T>(request) };
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return { failure: { message: error.message, status: 413 } };
    }

    return {
      failure: { message: 'Request body must be valid JSON', status: 400 },
    };
  }
};

/**
 * OpenAI-compatible variant of `readJsonBodyOrFailure`.
 */
export const readJsonBodyOrErrorResponse = async <T>(
  request: Request,
): Promise<{ body: T } | { response: Response }> => {
  const result = await readJsonBodyOrFailure<T>(request);

  if ('failure' in result) {
    const { message, status } = result.failure;

    return {
      response:
        status === 413
          ? createErrorResponse(413, message, {
              limit_bytes: MAX_REQUEST_BODY_BYTES,
            })
          : createErrorResponse(400, message),
    };
  }

  return result;
};

/**
 * Reads a forwarded header such as `x-forwarded-proto` or `x-forwarded-host`.
 *
 * Each proxy in a chain appends to these headers, so the value reaching us is
 * a comma-separated list whose first entry is the one the original client sent.
 * Reading the header whole is never right: `"https, http"` is not a protocol,
 * and `"example.com, proxy.internal"` is not a host — feeding either to
 * `new URL()` or `new Request()` throws and takes the page down with it.
 */
export const getForwardedHeaderValue = (
  headers: Headers,
  name: string,
): string | null => {
  const raw = headers.get(name);

  if (!raw) {
    return null;
  }

  const first = raw.split(',')[0]?.trim() ?? '';

  return first || null;
};

export const getRequestHeaderMap = (
  headers: Headers,
): Record<string, string> => {
  const passThroughNames = [
    'x-conversation-id',
    'x-conversation-request-id',
    'x-conversation-message-id',
    'x-request-id',
    'traceparent',
    'tracestate',
    'x-trace-id',
    'x-session-id',
    'x-originator',
    'session_id',
    'originator',
  ];

  return passThroughNames.reduce<Record<string, string>>((result, name) => {
    const value = headers.get(name);

    if (value) {
      if (name === 'session_id') {
        result['x-session-id'] = value;
      } else if (name === 'originator') {
        result['x-originator'] = value;
      } else {
        result[name] = value;
      }
    }

    return result;
  }, {});
};

/**
 * Digs the human-readable explanation out of an upstream error body.
 *
 * Upstream shapes nest the real message at different depths — `detail`,
 * `error.message`, or a JSON-encoded string standing in for either — so the
 * search recurses until it finds text. Returns null when nothing readable is
 * there, letting the caller fall back to the raw body.
 */
export const extractErrorMessage = (value: unknown): string | null => {
  if (typeof value === 'string') {
    try {
      return extractErrorMessage(JSON.parse(value) as unknown) ?? value;
    } catch {
      return value;
    }
  }
  if (!value || typeof value !== 'object') return null;

  const payload = value as {
    detail?: unknown;
    error?: unknown;
    message?: unknown;
  };
  const detail = extractErrorMessage(payload.detail);
  if (detail) return detail;
  if (typeof payload.message === 'string') return payload.message;
  return extractErrorMessage(payload.error);
};

export const createErrorResponse = (
  status: number,
  message: string,
  detail?: unknown,
): Response => {
  return Response.json(
    {
      error: {
        message,
        detail,
      },
    },
    { status },
  );
};
