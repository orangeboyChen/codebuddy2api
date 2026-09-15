/**
 * Deadline enforcement for proxied upstream requests.
 *
 * The window covers the wait for the upstream to start producing output, not
 * the total time a request may take: once the first delta arrives the model is
 * demonstrably working, and a long tail is a slow answer rather than a hung
 * one. Cutting a slow-but-healthy stream short would be worse than the hang it
 * protects against, so the deadline is released at the first sign of life and
 * every later read is left alone.
 */

const MS_PER_SECOND = 1000;

/**
 * Cap on the text retained while scanning for the first `data:` frame. Chunks
 * split mid-line, so the dangling tail has to be carried across reads, but it
 * must stay bounded because a stream with no newline would otherwise buffer
 * without limit.
 */
const MAX_SCAN_CARRY_BYTES = 64 * 1024;

export type UpstreamTimeoutPhase = 'response' | 'firstDelta';

export class UpstreamTimeoutError extends Error {
  readonly phase: UpstreamTimeoutPhase;
  readonly timeoutMs: number;

  constructor(timeoutMs: number, phase: UpstreamTimeoutPhase) {
    super(
      phase === 'firstDelta'
        ? `Upstream did not produce the first delta within ${Math.round(timeoutMs / MS_PER_SECOND)}s`
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

export interface UpstreamDeadline {
  /**
   * Wraps a response so the deadline is released once the upstream delivers its
   * first delta. Also advances the failure phase, so a timeout from here on is
   * reported as a missing delta rather than a missing response.
   */
  trackFirstDelta: (response: Response) => Response;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}

/**
 * True for an SSE frame that carries a payload. Keepalive comments (`: ping`),
 * empty `data:` lines and the terminating `[DONE]` are deliberately excluded:
 * they prove the socket is open but not that the model has produced anything,
 * so they must not release the deadline.
 */
const hasContentFrame = (text: string): boolean =>
  text.split('\n').some((line) => {
    const trimmed = line.trim();

    if (!trimmed.toLowerCase().startsWith('data:')) {
      return false;
    }

    const payload = trimmed.slice(5).trim();

    return payload.length > 0 && payload !== '[DONE]';
  });

export const createUpstreamDeadline = (timeoutMs: number): UpstreamDeadline => {
  const controller = new AbortController();
  let settled = false;
  let phase: UpstreamTimeoutPhase = 'response';
  /** Phase the deadline actually fired in, which may predate tracking. */
  let expiredPhase: UpstreamTimeoutPhase = 'response';
  /** Invoked when the deadline fires during the streaming phase. */
  let onExpired: (() => void) | null = null;

  const release = (): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
  };

  // Declared before the timer callback reads it, but only ever invoked after
  // this function body has run, so the TDZ cannot be observed.
  const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
    if (settled) return;
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

  const trackFirstDelta = (response: Response): Response => {
    phase = 'firstDelta';

    const contentType = response.headers.get('content-type') ?? '';
    const isEventStream = contentType
      .toLowerCase()
      .includes('text/event-stream');

    // Nothing left to wait for: either this is not an event stream and so has
    // no first delta to wait for, or the response has no body at all. Releasing
    // also drops the pending timer, which would otherwise keep the event loop
    // alive for the rest of the window.
    if (!response.body || !isEventStream) {
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
    const decoder = new TextDecoder();
    let carry = '';
    let marked = false;
    /**
     * Whether the downstream stream has already been closed, cancelled or
     * errored. Failing it again would throw, and that throw would escape as an
     * unhandled rejection, so a late deadline has to become a no-op.
     */
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
          carry += decoder.decode(value, { stream: true });

          const lines = carry.split('\n');
          carry = lines.pop() ?? '';

          if (hasContentFrame(lines.join('\n'))) {
            marked = true;
            carry = '';
            release();
          } else if (carry.length > MAX_SCAN_CARRY_BYTES) {
            carry = '';
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
            controller.error(new UpstreamTimeoutError(timeoutMs, 'firstDelta'));
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
    trackFirstDelta,
  };
};
