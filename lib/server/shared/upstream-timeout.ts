/**
 * Deadline enforcement for proxied upstream requests.
 *
 * The window covers the wait for the upstream to start producing output, not
 * the total time a request may take: once output arrives the model is
 * demonstrably working, and a long tail is a slow answer rather than a hung
 * one. Cutting a slow-but-healthy stream short would be worse than the hang it
 * protects against, so the deadline is released at the first sign of life and
 * every later read is left alone.
 */

import { createErrorResponse } from './http';

const MS_PER_SECOND = 1000;

/**
 * Cap on the text retained while scanning for the first `data:` frame. Chunks
 * split mid-line, so the dangling tail has to be carried across reads, but it
 * must stay bounded because a stream with no newline would otherwise buffer
 * without limit.
 */
const MAX_SCAN_CARRY_BYTES = 64 * 1024;

export type UpstreamTimeoutPhase = 'response' | 'firstOutput';

export class UpstreamTimeoutError extends Error {
  readonly phase: UpstreamTimeoutPhase;
  readonly timeoutMs: number;

  constructor(timeoutMs: number, phase: UpstreamTimeoutPhase) {
    super(
      phase === 'firstOutput'
        ? `Upstream did not produce output within ${Math.round(timeoutMs / MS_PER_SECOND)}s`
        : `Upstream did not respond within ${Math.round(timeoutMs / MS_PER_SECOND)}s`,
    );
    this.name = 'UpstreamTimeoutError';
    this.phase = phase;
    this.timeoutMs = timeoutMs;
  }
}

export const isUpstreamTimeoutError = (
  error: unknown,
): error is UpstreamTimeoutError => error instanceof UpstreamTimeoutError;

/**
 * The message to surface to a client when a deadline fires, or null when the
 * failure was something else. Lets a pump reuse its existing error path and
 * still report a timeout in that protocol's own shape.
 */
export const toUpstreamTimeoutMessage = (error: unknown): string | null =>
  isUpstreamTimeoutError(error) ? error.message : null;

/**
 * Recognises the error chunk and Anthropic error event this module emits, so a
 * mapper wrapping another mapper can tell that its upstream already failed.
 *
 * This matters because the proxy nests: a Responses or Messages request runs
 * through the chat pipeline, which turns a timeout into a terminal error chunk
 * and closes cleanly. The outer mapper sees an ordinary end-of-stream and would
 * otherwise finalise an empty success, hiding the failure from the client.
 */
/**
 * Shared prefix of every message this module produces, used by a wrapping
 * mapper to recognise that its upstream already hit a deadline.
 */
const TIMEOUT_MESSAGE_PREFIX = 'Upstream did not ';

export const isUpstreamTimeoutText = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith(TIMEOUT_MESSAGE_PREFIX);

/**
 * Reads the payload of a `data:` line, or null when the line carries no
 * parseable payload.
 */
const readDataPayload = (frame: string): string | null => {
  const dataLine = frame
    .split('\n')
    .find((line) => line.trim().toLowerCase().startsWith('data:'));

  if (!dataLine) {
    return null;
  }

  const payload = dataLine.slice(dataLine.indexOf(':') + 1).trim();

  return !payload || payload === '[DONE]' ? null : payload;
};

export const isTerminalErrorFrame = (frame: string): boolean => {
  const payload = readDataPayload(frame);

  if (payload === null) {
    return false;
  }

  try {
    const parsed = JSON.parse(payload) as {
      error?: unknown;
      type?: unknown;
    };

    // Matches both shapes this module emits: the OpenAI error chunk
    // (`{ error: { message } }`) and the Anthropic error event
    // (`{ type: 'error', error: { message } }`).
    return Boolean(parsed.error) || parsed.type === 'error';
  } catch {
    return false;
  }
};

/**
 * Pulls the message out of a terminal error frame, falling back to a generic
 * description when the payload cannot be read.
 */
const readFrameMessage = (frame: string): string | null => {
  if (!isTerminalErrorFrame(frame)) {
    return null;
  }

  const payload = readDataPayload(frame) as string;

  try {
    const parsed = JSON.parse(payload) as {
      error?: { message?: unknown };
      message?: unknown;
    };
    const message = parsed.error?.message ?? parsed.message;

    return typeof message === 'string' ? message : null;
  } catch {
    return null;
  }
};

/**
 * The message when `frame` reports that the upstream hit a deadline, else null.
 *
 * Restricted to deadlines on purpose: the chat pipeline also emits error frames
 * for oversized SSE frames, and those are already surfaced by the wrapping
 * mapper through its own rejection path. Treating every error frame as fatal
 * here would turn unrelated, already-handled failures into timeouts.
 */
export const readTimeoutFrame = (frame: string): string | null => {
  const message = readFrameMessage(frame);

  return isUpstreamTimeoutText(message) ? message : null;
};

/** Non-streaming failures report as 504; the body carries the detail. */
export const createUpstreamTimeoutResponse = (message: string): Response =>
  createErrorResponse(504, 'Upstream CodeBuddy request timed out', message);

export interface UpstreamDeadline {
  /**
   * Wraps a response so the deadline is released once the upstream delivers its
   * first output. Also advances the failure phase, so a timeout from here on is
   * reported as missing output rather than a missing response.
   */
  trackFirstOutput: (response: Response) => Response;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}

/**
 * Native Responses events that carry model output. Lifecycle events such as
 * `response.created`, `response.in_progress` and `response.output_item.added`
 * arrive before the model has produced anything, so they must not count as
 * progress — otherwise a model that stalls after saying hello keeps the
 * deadline released forever.
 */
const isResponsesOutputDelta = (type: unknown): boolean =>
  typeof type === 'string' &&
  type.startsWith('response.') &&
  type.endsWith('.delta');

/**
 * OpenAI-shaped chunks that carry model output: text, reasoning, or tool-call
 * fragments. A chunk carrying only `role`, `usage`, or an empty delta is a
 * lifecycle or keepalive frame rather than output.
 */
const isChatOutputDelta = (event: unknown): boolean => {
  const { choices } = event as { choices?: unknown };

  if (!Array.isArray(choices)) {
    return false;
  }

  return choices.some((choice) => {
    const { delta } = choice as { delta?: unknown };

    if (!delta || typeof delta !== 'object') {
      return false;
    }

    const { content, reasoning, reasoning_content, tool_calls } = delta as {
      content?: unknown;
      reasoning?: unknown;
      reasoning_content?: unknown;
      tool_calls?: unknown;
    };

    return Boolean(content ?? reasoning_content ?? reasoning ?? tool_calls);
  });
};

/**
 * Decides whether one SSE `data:` payload counts as upstream output.
 *
 * A payload that cannot be parsed is treated as progress: refusing to classify
 * it would let an unfamiliar-but-healthy frame kill a working stream, which is
 * the worse failure of the two.
 */
const isOutputPayload = (payload: string): boolean => {
  let event: unknown;

  try {
    event = JSON.parse(payload);
  } catch {
    return true;
  }

  const { type } = event as { type?: unknown };

  if (isResponsesOutputDelta(type)) {
    return true;
  }

  return isChatOutputDelta(event);
};

/**
 * True when the given SSE text contains a `data:` frame carrying output.
 * Keepalive comments (`: ping`), empty `data:` lines and the terminating
 * `[DONE]` are deliberately excluded, as are lifecycle frames.
 */
const hasOutputFrame = (text: string): boolean =>
  text.split('\n').some((line) => {
    const trimmed = line.trim();

    if (!trimmed.toLowerCase().startsWith('data:')) {
      return false;
    }

    const payload = trimmed.slice(5).trim();

    return (
      payload.length > 0 && payload !== '[DONE]' && isOutputPayload(payload)
    );
  });

export const createUpstreamDeadline = (timeoutMs: number): UpstreamDeadline => {
  const controller = new AbortController();
  let settled = false;
  let phase: UpstreamTimeoutPhase = 'response';
  /** Phase the deadline actually fired in, which may predate tracking. */
  let expiredPhase: UpstreamTimeoutPhase = 'response';
  /** Invoked when the deadline fires while a response body is being read. */
  let onExpired: (() => void) | null = null;

  const release = (): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
  };

  // Declared before the timer callback reads it, but only ever invoked after
  // this function body has run, so the TDZ cannot be observed.
  const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
    settled = true;
    expiredPhase = phase;

    const error = new UpstreamTimeoutError(timeoutMs, phase);

    // Aborting only reaches a fetch that is still in flight. Once headers have
    // arrived, cancelling the body is what actually stops the wait, so both are
    // attempted and whichever applies wins.
    //
    // The whole callback is wrapped because a timer is the last place a
    // rejection can be caught: nothing awaits it, so anything thrown here —
    // including from a consumer callback that has moved on — becomes an
    // unhandled rejection that can take the process down.
    try {
      controller.abort(error);
      onExpired?.();
    } catch {
      // Nothing is listening any more; the timeout has no one to report to.
    }
  }, timeoutMs);

  const trackFirstOutput = (response: Response): Response => {
    phase = 'firstOutput';

    // A body is required for anything to arrive, so with none there is nothing
    // the deadline could be waiting for. Releasing also drops the pending
    // timer, which would otherwise keep the event loop alive for the rest of
    // the window.
    if (!response.body) {
      release();
      return response;
    }

    // The deadline can expire in the gap between `fetch` resolving and this
    // wrapper being installed. Hand the caller back a stream that fails with
    // the timeout rather than one that would hang forever, and release the
    // upstream body nobody is going to read.
    if (settled) {
      void response.body.cancel().catch(() => undefined);

      return new Response(
        new ReadableStream<Uint8Array>({
          start(streamController): void {
            streamController.error(
              new UpstreamTimeoutError(timeoutMs, expiredPhase),
            );
          },
        }),
        {
          headers: response.headers,
          status: response.status,
          statusText: response.statusText,
        },
      );
    }
    const reader = response.body.getReader();
    const isEventStream = (response.headers.get('content-type') ?? '')
      .toLowerCase()
      .includes('text/event-stream');
    const decoder = new TextDecoder();
    let carry = '';
    let marked = false;
    /**
     * Whether this wrapper has already errored the downstream stream. The
     * deadline cancels the upstream reader, which resolves the pending `read`
     * as done and re-enters `pull` — which would then try to `close` a stream
     * that was just errored. `desiredSize` cannot detect that (it is still
     * non-null at that point), so the state has to be tracked explicitly.
     */
    let failed = false;

    /**
     * Closing a stream that has already been errored throws, and a throw
     * inside `pull` surfaces as an unhandled rejection rather than anything a
     * caller can catch, so every terminal action is guarded.
     */
    const close = (
      controller: ReadableStreamDefaultController<Uint8Array>,
    ): void => {
      if (failed) return;

      try {
        controller.close();
      } catch {
        // The consumer closed or errored the stream first; nothing to do.
      }
    };

    const stream = new ReadableStream<Uint8Array>({
      async cancel(reason): Promise<void> {
        failed = true;
        release();
        await reader.cancel(reason);
      },
      async pull(controller): Promise<void> {
        const { done, value } = await reader.read();

        // The upstream finished, so the deadline has nothing left to guard.
        // `release` clears the timer, and `failed` keeps a late fire from
        // erroring a stream that has already reached its end.
        if (done) {
          release();
          close(controller);
          return;
        }

        if (!marked) {
          // A JSON body has no deltas to look for: the first byte is already
          // proof that the upstream started answering, which is all this
          // deadline promises to wait for.
          if (!isEventStream) {
            marked = true;
            release();
          } else {
            carry += decoder.decode(value, { stream: true });

            const lines = carry.split('\n');
            carry = lines.pop() ?? '';

            if (hasOutputFrame(lines.join('\n'))) {
              marked = true;
              carry = '';
              release();
            } else if (carry.length > MAX_SCAN_CARRY_BYTES) {
              carry = '';
            }
          }
        }

        if (failed) return;

        try {
          controller.enqueue(value);
        } catch {
          // The consumer errored or closed the stream first.
        }
      },
      start(controller): void {
        onExpired = (): void => {
          // Cancel first so the upstream socket is released rather than left
          // draining into a stream nobody will read, then fail the downstream
          // so the client sees a timeout instead of a truncated answer.
          void reader.cancel().then(
            () => undefined,
            () => undefined,
          );

          if (failed) {
            return;
          }

          failed = true;

          try {
            controller.error(
              new UpstreamTimeoutError(timeoutMs, 'firstOutput'),
            );
          } catch {
            // The stream may already be closed or errored by the consumer.
          }
        };
      },
    });

    return new Response(stream, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    });
  };

  return {
    signal: controller.signal,
    timeoutMs,
    trackFirstOutput,
  };
};

export interface UpstreamFetchResult {
  /** False when the deadline fired before upstream output began. */
  ok: boolean;
  response: Response;
}

/**
 * Issues an upstream request under a deadline and wraps the body so the
 * deadline is released once output starts. Returns `ok: false` with a 504
 * response when the deadline fires, so callers can bail out before treating
 * the result as an upstream response.
 */
export const fetchWithDeadline = async ({
  body,
  headers,
  onTimeout,
  timeoutMs,
  url,
}: {
  body: string;
  headers: HeadersInit;
  onTimeout?: (error: UpstreamTimeoutError) => void;
  timeoutMs: number;
  url: string;
}): Promise<UpstreamFetchResult> => {
  const deadline = createUpstreamDeadline(timeoutMs);
  let response: Response;

  try {
    response = await fetch(url, {
      body,
      cache: 'no-store',
      headers,
      method: 'POST',
      signal: deadline.signal,
    });
  } catch (error) {
    if (!isUpstreamTimeoutError(error)) throw error;

    onTimeout?.(error);

    return {
      ok: false,
      response: createUpstreamTimeoutResponse(error.message),
    };
  }

  return { ok: true, response: deadline.trackFirstOutput(response) };
};

// ---------------------------------------------------------------------------
// Terminal-error reporting for streamed responses
// ---------------------------------------------------------------------------

/**
 * Tracks whether a downstream stream has already reached a terminal state.
 *
 * A deadline errors the upstream stream before the pump observes it, so by the
 * time the pump's catch runs the controller may already be closed and any
 * write would throw — inside a catch handler, where nothing can observe it
 * except the process-level unhandled-rejection hook.
 */
export const createStreamCloser = (): {
  readonly closed: boolean;
  fail: (
    controller: ReadableStreamDefaultController<Uint8Array>,
    chunks: Uint8Array[],
  ) => void;
  mark: () => void;
} => {
  let closed = false;

  return {
    get closed(): boolean {
      return closed;
    },
    /** Writes `chunks` then closes, all skipped if already terminal. */
    fail(controller, chunks): void {
      if (closed) return;

      try {
        chunks.forEach((chunk) => controller.enqueue(chunk));
      } catch {
        return;
      }

      closed = true;

      try {
        controller.close();
      } catch {
        // The consumer closed or errored the stream first; nothing to do.
      }
    },
    mark: (): void => {
      closed = true;
    },
  };
};

const encoder = new TextEncoder();

/** OpenAI-compatible terminal frames: an error chunk, then the stream end. */
export const chatStreamErrorChunks = (message: string): Uint8Array[] => [
  encoder.encode(`data: ${JSON.stringify({ error: { message } })}\n\n`),
  encoder.encode('data: [DONE]\n\n'),
];

/**
 * Native Responses terminal frames. This path forwards upstream frames
 * verbatim, so the error has to arrive as that protocol's own event.
 */
export const responsesStreamErrorChunks = (message: string): Uint8Array[] => [
  encoder.encode(
    `event: response.error\ndata: ${JSON.stringify({
      error: { message },
      type: 'response.error',
    })}\n\n`,
  ),
  encoder.encode('data: [DONE]\n\n'),
];

/**
 * Anthropic Messages terminal frame. A timeout is the upstream failing rather
 * than a bad request, so it reports as `api_error` — the type clients treat as
 * retryable — instead of the `invalid_request_error` used for malformed input.
 */
export const anthropicStreamErrorChunks = (message: string): Uint8Array[] => [
  encoder.encode(
    `event: error\ndata: ${JSON.stringify({
      type: 'error',
      error: { type: 'api_error', message },
    })}\n\n`,
  ),
];
