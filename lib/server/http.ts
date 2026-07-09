export const getJsonBody = async <T>(request: Request): Promise<T> => {
  return (await request.json()) as T;
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
