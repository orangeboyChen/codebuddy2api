import { extractErrorMessage } from '../shared/http';

export const anthropicErrorType = (status: number): string =>
  status === 401
    ? 'authentication_error'
    : status === 403
      ? 'permission_error'
      : status === 404
        ? 'not_found_error'
        : status === 413
          ? 'request_too_large'
          : status === 429
            ? 'rate_limit_error'
            : status === 529
              ? 'overloaded_error'
              : status >= 500
                ? 'api_error'
                : 'invalid_request_error';

export const getUpstreamErrorMessage = async (
  response: Response,
): Promise<string> => {
  const text = await response.text();
  if (!text) return 'Upstream CodeBuddy request failed';

  try {
    return extractErrorMessage(JSON.parse(text) as unknown) ?? text;
  } catch {
    return text;
  }
};

export const createAnthropicError = (
  status: number,
  message: string,
): Response => {
  const type = anthropicErrorType(status);

  return Response.json(
    {
      type: 'error',
      error: {
        type,
        message,
      },
    },
    { status },
  );
};
