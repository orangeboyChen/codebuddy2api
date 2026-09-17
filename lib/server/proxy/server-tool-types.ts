import type {
  WebFetchQuery,
  WebFetchResponse,
  WebSearchResponse,
} from '../search/types';
import type { ChatRequestBody } from './codebuddy';

export const MAX_SEARCH_ITERATIONS = 5;
export const STREAM_TEXT_CHUNK_LENGTH = 1024;

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

/**
 * Result of one server-tool pass.
 *
 * `response` is null when no tool could be executed: the request still has to
 * be sent, but with the server-tool declarations already stripped, so the
 * caller falls through to its ordinary upstream path.
 */
export interface ServerToolLoopResult {
  body: ChatRequestBody;
  executions: ServerToolExecution[];
  response: Response | null;
  /**
   * One entry per server-tool hop, in the order the model produced them.
   *
   * Carries the grouping `message.content` / `reasoning_content` cannot: a
   * multi-hop turn joins every hop into one string per kind, which loses where
   * one hop's reasoning ends and the next begins. Travels beside the response
   * rather than inside it, because it is not part of the OpenAI protocol — a
   * block renderer reads it off the response through `getServerToolTurns`.
   * Empty when no hop ran.
   */
  turns: ServerToolTurn[];
}

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
 * One server-tool hop as the model produced it.
 *
 * `reasoning` and `text` are what the model wrote before the calls in
 * `executions`; both are empty when it called tools without speaking first. The
 * last hop of a turn usually has no executions, because the model answered
 * instead of reaching for another tool.
 */
export interface ServerToolTurn {
  executions: ServerToolExecution[];
  reasoning: string;
  text: string;
}

export interface ServerToolCallbacks {
  emitStreamEvents?: boolean;
  /**
   * Set by routes that render a server tool's findings structurally —
   * Anthropic's `web_search_tool_result` block — instead of as prose. Those
   * routes must not also fold the same findings into the assistant text, or
   * the user sees the results twice: once as a result block and once as if
   * the model had written them.
   */
  findingsAsStructuredBlocks?: boolean;
  onCall?: (invocation: ServerToolInvocation) => void;
  onResult?: (execution: ServerToolExecution) => void;
}

export const SERVER_TOOL_STREAM_EVENT_KEY = 'x-codebuddy2api-server-tool';

export type ServerToolStreamEvent =
  | { invocation: ServerToolInvocation; phase: 'call' }
  | { execution: ServerToolExecution; phase: 'result' };

export type ServerToolUpstreamMode =
  'buffer' | 'detect-both' | 'detect-fetch' | 'detect-search' | 'stream';
