/**
 * Server tools the proxy runs on the client's behalf.
 *
 * A client asks a provider to run a search by declaring a *provider-executed*
 * tool: Anthropic sends a dated type (`web_search_20250305`), the Responses API
 * sends `web_search_preview`. Upstream CodeBuddy has neither, so the proxy
 * executes the call against a configured backend and hands the findings back
 * as if upstream had produced them.
 *
 * What is deliberately absent here is a loop. A server tool is answered in one
 * bounded turn: the model asks for a search, the proxy runs it, and upstream is
 * asked once more — without the server tools available to call again — to write
 * the answer. Iterating until the model stops asking would be a loop, and the
 * corrected flow does not need one: a client that wants several searches issues
 * several requests, which is exactly what Claude Code does when it answers its
 * own `WebSearch` tool.
 */

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
 * Result of one server-tool turn.
 *
 * `response` is the upstream response to render as the assistant's answer, and
 * it is always present: the turn has already spent the first upstream call, and
 * a caller that re-issued the request would bill the turn twice.
 */
export interface ServerToolTurnOutcome {
  /** Calls executed locally, in the order the model made them. */
  executions: ServerToolExecution[];
  /** What the model wrote before those calls. Empty when it spoke only after. */
  preamble: ServerToolPreamble;
  response: Response;
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

export const attachServerToolExecutions = (
  response: Response,
  executions: ServerToolExecution[],
): Response => {
  if (executions.length) {
    serverToolExecutions.set(response, executions);
  }

  return response;
};

export const getServerToolExecutions = (
  response: Response,
): ServerToolExecution[] => serverToolExecutions.get(response) ?? [];
