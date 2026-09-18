import { extractErrorMessage } from '../../shared/http';
import type { ChatCompletionPayload } from './types';

/**
 * Parses a buffered upstream body, tolerating a failure that is not JSON.
 *
 * A successful response must be well-formed — anything else is a bug worth
 * surfacing — but a failure status already tells the caller everything it
 * needs to know, and its body may legitimately be an HTML error page or a
 * bare string. Rejecting on those would turn an ordinary outage into an
 * unhandled rejection.
 */
export const parseBufferedPayload = (
  buffered: string,
  ok: boolean,
): ChatCompletionPayload => {
  try {
    return JSON.parse(buffered) as ChatCompletionPayload;
  } catch (error) {
    if (ok) {
      throw error;
    }

    return {};
  }
};

/**
 * Reads and parses a buffered upstream body.
 *
 * `buffered` is passed in rather than read here because the caller has already
 * consumed the response to get at it: a `Response` body can be read once, and
 * reading it again throws "Body already used". The response is still needed for
 * its status and headers.
 */
export const readBufferedChatCompletionPayload = async (
  response: Response,
  buffered?: string,
): Promise<ChatCompletionPayload> => {
  const text = buffered ?? (await response.clone().text());
  const payload = parseBufferedPayload(text, response.ok);

  if (!response.ok || payload.error) {
    const ownMessage = payload.error?.message;
    // `extractErrorMessage` digs a nested message out of the payload, so
    // `{"error":{"message":"x"}}` reaches the client as "x" rather than as a
    // JSON string. The raw body is the fallback: a payload carrying only a
    // code has no message to find, and the JSON is still the only record of
    // what happened. An empty body says nothing, so it falls all the way
    // through to the generic message instead of winning on being non-null.
    const detail = text.trim();

    return {
      ...payload,
      error: {
        // The upstream's own explanation — a rate-limit code, a reset
        // timestamp — beats the proxy's generic "Upstream CodeBuddy request
        // failed", which says only that something failed and leaves the client
        // no way to tell what.
        //
        // `status` travels with the frame so a downstream mapper can name the
        // real error type instead of guessing it from the message text.
        message:
          extractErrorMessage(payload) ??
          ownMessage ??
          (detail || `Upstream request failed with status ${response.status}`),
        ...(response.ok ? {} : { status: response.status }),
      },
    };
  }

  return payload;
};
