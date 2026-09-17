import { runWebFetchResult, runWebSearchResult } from '../search';
import type { WebFetchProvider, WebSearchProvider } from '../search/types';
import { asRecord } from '../shared/content';
import { extractFetchQuery, extractSearchQuery } from './server-tool-args';
import { isWebFetchToolCall } from './server-tool-classify';
import {
  SERVER_TOOL_STREAM_EVENT_KEY,
  type ChatCompletionToolCall,
  type ServerToolCallbacks,
  type ServerToolExecution,
  type ServerToolInvocation,
  type ServerToolStreamEvent,
  type ServerToolTurn,
} from './server-tool-types';

export const getServerToolStreamEvent = (
  value: unknown,
): ServerToolStreamEvent | null => {
  const record = asRecord(value);
  const event = asRecord(record?.[SERVER_TOOL_STREAM_EVENT_KEY]);

  if (event?.phase === 'call' && event.invocation) {
    return {
      invocation: event.invocation as ServerToolInvocation,
      phase: 'call',
    };
  }

  if (event?.phase === 'result' && event.execution) {
    return {
      execution: event.execution as ServerToolExecution,
      phase: 'result',
    };
  }

  return null;
};

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

/**
 * Per-hop grouping, kept off the wire for the same reason `executions` is: it
 * is not part of the OpenAI protocol, so a `/v1/chat/completions` client must
 * not see it — a strict validator can reject the extra field, and the tool
 * data would otherwise be sent twice.
 */
const serverToolTurns = new WeakMap<Response, ServerToolTurn[]>();

export const attachServerToolTurns = (
  response: Response,
  turns: ServerToolTurn[],
): Response => {
  if (turns.length) {
    serverToolTurns.set(response, turns);
  }

  return response;
};

export const getServerToolTurns = (
  response: Response,
): ServerToolTurn[] | undefined => serverToolTurns.get(response);

export const buildServerToolInvocation = (
  toolCall: ChatCompletionToolCall,
  iteration: number,
  index: number,
): ServerToolInvocation =>
  isWebFetchToolCall(toolCall)
    ? {
        id: toolCall.id ?? `server_tool_${iteration}_${index}`,
        input: extractFetchQuery(toolCall.function?.arguments),
        type: 'web_fetch',
      }
    : {
        id: toolCall.id ?? `server_tool_${iteration}_${index}`,
        input: { query: extractSearchQuery(toolCall.function?.arguments) },
        type: 'web_search',
      };

export const executeServerToolInvocations = async ({
  callbacks,
  fetchProvider,
  invocations,
  searchProvider,
}: {
  callbacks?: ServerToolCallbacks;
  fetchProvider: WebFetchProvider | null;
  invocations: ServerToolInvocation[];
  searchProvider: WebSearchProvider | null;
}): Promise<
  Array<{
    content: string;
    execution: ServerToolExecution;
    tool_call_id: string;
  }>
> => {
  invocations.forEach((invocation) => callbacks?.onCall?.(invocation));

  return await Promise.all(
    invocations.map(async (invocation) => {
      if (invocation.type === 'web_fetch') {
        const result = await runWebFetchResult({
          provider: fetchProvider,
          query: invocation.input,
        });
        const execution: ServerToolExecution = { ...invocation, result };
        callbacks?.onResult?.(execution);

        return {
          content: result.content,
          execution,
          tool_call_id: invocation.id,
        };
      }

      const result = await runWebSearchResult({
        provider: searchProvider,
        query: invocation.input.query,
      });
      const execution: ServerToolExecution = { ...invocation, result };
      callbacks?.onResult?.(execution);

      return {
        content: result.content,
        execution,
        tool_call_id: invocation.id,
      };
    }),
  );
};
