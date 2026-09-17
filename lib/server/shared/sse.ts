/**
 * Server-sent-event framing shared by every streaming response shape the proxy
 * serves.
 *
 * The header block and the terminating `[DONE]` frame were previously spelled
 * out inline at a dozen sites, which is how one of them ended up carrying a CORS
 * header the rest did not. Keeping them here also keeps the three protocols in
 * step when the framing has to change.
 */

const SSE_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'Content-Type': 'text/event-stream; charset=utf-8',
};

/**
 * Headers for an SSE response. `status` defaults to 200 because a stream is
 * produced once the upstream has already been accepted; callers replying with
 * an upstream's status pass it explicitly.
 */
export const createSseHeaders = (
  overrides?: Record<string, string>,
): Record<string, string> => ({ ...SSE_HEADERS, ...overrides });

export const createSseResponse = (
  body: BodyInit | null,
  init?: { headers?: Record<string, string>; status?: number },
): Response =>
  new Response(body, {
    headers: createSseHeaders(init?.headers),
    status: init?.status ?? 200,
  });

const encoder = new TextEncoder();

/**
 * Text forms, for bodies assembled by joining strings rather than by enqueuing
 * chunks onto a stream. The `\n\n` terminator comes from the join, so neither
 * form carries one of its own.
 */
export const eventFrameText = (type: string, data: unknown): string =>
  `event: ${type}\ndata: ${JSON.stringify(data)}`;

export const DONE_FRAME_TEXT = 'data: [DONE]';

/**
 * Serialises one named event. Used where the protocol requires an `event:`
 * line — Responses and Anthropic both key their consumers off it, while the
 * OpenAI chat shape omits it.
 */
export const encodeEventFrame = (type: string, data: unknown): Uint8Array =>
  encoder.encode(`${eventFrameText(type, data)}\n\n`);

/** The frame that ends an SSE stream. */
export const encodeDoneFrame = (): Uint8Array =>
  encoder.encode(`${DONE_FRAME_TEXT}\n\n`);
