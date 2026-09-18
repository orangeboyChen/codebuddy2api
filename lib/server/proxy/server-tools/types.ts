/**
 * Server tools the proxy runs on the client's behalf.
 *
 * A client asks a provider to run a search by declaring a *provider-executed*
 * tool: Anthropic sends a dated type (`web_search_20250305`), the Responses API
 * sends `web_search_preview`. Upstream CodeBuddy has neither, so the proxy
 * executes the call against a configured backend and hands the findings back
 * as if upstream had produced them.
 *
 * The loop lives *inside* one request, which is what a server tool means to
 * the client: the model asks for a search, the proxy runs it, feeds the
 * findings back, and upstream decides whether to search again or write the
 * answer. Only the finished turn crosses the wire.
 *
 * What is deliberately absent is a loop over the *client's* tools. Claude Code
 * declares `WebSearch` as an ordinary function and resolves it itself, so a
 * call to it goes straight back — the proxy never picks it up.
 */

import { asRecord } from '../../shared/content';
import type {
  WebFetchQuery,
  WebFetchResponse,
  WebSearchResponse,
} from '../../search/types';

export type JsonRecord = Record<string, unknown>;

export interface ChatCompletionToolCall {
  id?: string;
  index?: number;
  type?: string;
  function?: {
    arguments?: string;
    name?: string;
  };
}

export interface ChatCompletionMessage {
  content?: string | null;
  reasoning?: string;
  reasoning_content?: string;
  role?: string;
  tool_calls?: ChatCompletionToolCall[];
}

export interface ChatCompletionPayload {
  choices?: Array<{
    finish_reason?: string | null;
    index?: number;
    message?: ChatCompletionMessage;
  }>;
  created?: number;
  /**
   * `status` is the upstream HTTP status, carried so a downstream mapper can
   * name the real error type instead of guessing it from the message text. It
   * is absent for a payload that already reported an error of its own.
   */
  error?: { message?: string; status?: number };
  id?: string;
  model?: string;
  object?: string;
  usage?: unknown;
}

/** Text slice size when a buffered completion is replayed as SSE. */
export const STREAM_TEXT_CHUNK_LENGTH = 1024;

/** The two tools this proxy can execute, named by what they do. */
export type ServerToolKind = 'web_fetch' | 'web_search';

export type ServerToolInvocation =
  | {
      id: string;
      input: { query: string };
      type: 'web_search';
    }
  | {
      id: string;
      input: WebFetchQuery;
      type: 'web_fetch';
    };

export type ServerToolExecution =
  | (Extract<ServerToolInvocation, { type: 'web_search' }> & {
      result: WebSearchResponse;
    })
  | (Extract<ServerToolInvocation, { type: 'web_fetch' }> & {
      result: WebFetchResponse;
    });

/**
 * Prose the model produced before it reached for a server tool.
 *
 * Anthropic puts that prose *ahead* of the `server_tool_use` block, so it has
 * to travel separately from the answer written after the results came back:
 * joining the two would show the user a conclusion before the search that
 * produced it.
 */
export interface ServerToolPreamble {
  reasoning: string;
  text: string;
}

export const EMPTY_PREAMBLE: ServerToolPreamble = { reasoning: '', text: '' };

/**
 * One hop of a server-tool turn: what the model said, then what it asked for.
 *
 * A turn is a list of these. Anthropic interleaves prose and server-tool
 * blocks rather than gathering them by kind, so the grouping has to survive
 * to the renderer — a single "preamble" loses everything written between two
 * searches.
 */
export interface ServerToolSegment {
  /** Prose and reasoning the model produced before these calls. */
  reasoning: string;
  text: string;
  /** The calls this hop ran, in call order. */
  executions: ServerToolExecution[];
}

/**
 * Result of one server-tool turn.
 *
 * `response` is the upstream response to render as the assistant's answer, and
 * it is always present: the turn has already spent the first upstream call, and
 * a caller that re-issued the request would bill the turn twice.
 */
export interface ServerToolTurnOutcome {
  /** Calls executed locally, in the order the model made them. */
  executions: ServerToolExecution[];
  /**
   * The messages the turn appended to the transcript it was handed: the
   * assistant messages carrying its calls, and the tool results behind them.
   *
   * The turn builds its continuation internally, so a caller that drives
   * upstream across several rounds — the image-generation loop — has to splice
   * these into its own copy of the messages. Without them the next round asks
   * the model to continue a turn whose findings are nowhere in its input: the
   * search ran, was billed, and was then thrown away.
   */
  followUpMessages: JsonRecord[];
  /**
   * The hops, each with the prose that preceded it. The closing answer is not
   * here — it is in `response`.
   */
  segments: ServerToolSegment[];
  response: Response;
  /**
   * Token usage for the whole turn, summed across every hop. Carried here
   * rather than read off `response` because a hop only ever reports its own
   * usage, and the client is billed for all of them.
   */
  usage: unknown;
}

/**
 * Out-of-band channel for the calls a turn executed.
 *
 * The image-generation loop drives upstream itself and may surface a server
 * tool call on any of its hops, so it needs to collect executions from
 * responses it did not produce. The alternative — threading a collector
 * through every layer between the two — would couple them for one field.
 */
const serverToolExecutions = new WeakMap<Response, ServerToolExecution[]>();

const serverToolFollowUpMessages = new WeakMap<Response, JsonRecord[]>();

/**
 * Hangs both out-of-band channels on the response a turn hands back.
 *
 * `followUpMessages` ride along for the same reason `executions` do — see the
 * note above — and only ever matter to a caller that drives upstream itself.
 */
export const attachServerToolExecutions = (
  response: Response,
  executions: ServerToolExecution[],
  followUpMessages: JsonRecord[] = [],
): Response => {
  if (executions.length) {
    serverToolExecutions.set(response, executions);
  }

  if (followUpMessages.length) {
    serverToolFollowUpMessages.set(response, followUpMessages);
  }

  return response;
};

export const getServerToolExecutions = (
  response: Response,
): ServerToolExecution[] => serverToolExecutions.get(response) ?? [];

/**
 * The messages a turn appended to the transcript it was handed, read off a
 * response it produced. Empty when no server tool ran.
 */
export const getServerToolFollowUpMessages = (
  response: Response,
): JsonRecord[] => serverToolFollowUpMessages.get(response) ?? [];

/**
 * Adds two usage blocks together.
 *
 * A turn iterates: every hop upstream is a real request, and the client is
 * billed for all of them. Adding only the last would under-report the turn by
 * every search that preceded it.
 *
 * Fields present on either side are summed when both are numbers and taken
 * from the right otherwise — a later response supersedes an earlier count for
 * the same key rather than inventing a total from two partial readings.
 */
const asUsageRecord = (value: unknown): Record<string, unknown> | null =>
  asRecord(value);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  asRecord(value) !== null;

export const sumUsage = (accumulated: unknown, incoming: unknown): unknown => {
  const left = asUsageRecord(accumulated);
  const right = asUsageRecord(incoming);

  if (!left) {
    return incoming ?? null;
  }

  if (!right) {
    return accumulated;
  }

  const merged: Record<string, unknown> = { ...left };

  for (const [key, value] of Object.entries(right)) {
    const previous = left[key];

    if (typeof value === 'number' && typeof previous === 'number') {
      merged[key] = previous + value;
    } else if (isPlainObject(value) && isPlainObject(previous)) {
      // Nested blocks such as `prompt_tokens_details` are summed field by
      // field. Taking the later hop's object instead would report the cache
      // tokens of the last hop only, under-counting the turn.
      merged[key] = sumUsage(previous, value);
    } else if (value !== undefined) {
      merged[key] = value;
    }
  }

  return merged;
};
