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

export const getJsonBody = async <T>(request: Request): Promise<T> => {
  const declaredBytes = getDeclaredBodyBytes(request);

  // Reject a large body from Content-Length when the header is present: that
  // avoids buffering it at all. Chunked requests fall through to the
  // post-read check below, since they declare no length.
  if (declaredBytes !== null && declaredBytes > MAX_REQUEST_BODY_BYTES) {
    throw new RequestBodyTooLargeError(MAX_REQUEST_BODY_BYTES);
  }

  const text = await request.text();
  const actualBytes = Buffer.byteLength(text, 'utf8');

  if (actualBytes > MAX_REQUEST_BODY_BYTES) {
    throw new RequestBodyTooLargeError(MAX_REQUEST_BODY_BYTES);
  }

  return JSON.parse(text) as T;
};

/**
 * Same as `getJsonBody`, but converts a malformed or oversized body into a
 * proper 400/413 response instead of letting it escape as an unhandled
 * rejection.
 */
export const readJsonBodyOrErrorResponse = async <T>(
  request: Request,
): Promise<{ body: T } | { response: Response }> => {
  try {
    return { body: await getJsonBody<T>(request) };
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return {
        response: createErrorResponse(413, error.message, {
          limit_bytes: error.limitBytes,
        }),
      };
    }

    return {
      response: createErrorResponse(400, 'Request body must be valid JSON'),
    };
  }
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
