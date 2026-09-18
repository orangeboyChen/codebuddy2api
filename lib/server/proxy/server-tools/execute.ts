import { runWebFetchResult, runWebSearchResult } from '../../search';
import type { WebFetchProvider, WebSearchProvider } from '../../search/types';
import { extractFetchQuery, extractSearchQuery } from './args';
import type {
  ChatCompletionToolCall,
  ServerToolExecution,
  ServerToolInvocation,
  ServerToolKind,
} from './types';

/**
 * Turns one tool call into the invocation a backend runs.
 *
 * `kind` comes from the classifier that already recognised the call, rather
 * than being re-derived from the name here: re-deriving it means re-spelling
 * it, and respelling tool names is exactly how the client's own `WebSearch`
 * came to be mistaken for the server tool.
 */
export const buildServerToolInvocation = (
  toolCall: ChatCompletionToolCall,
  kind: ServerToolKind,
  index: number,
): ServerToolInvocation => {
  const id = toolCall.id ?? `server_tool_${index}`;

  return kind === 'web_fetch'
    ? {
        id,
        input: extractFetchQuery(toolCall.function?.arguments),
        type: 'web_fetch',
      }
    : {
        id,
        input: { query: extractSearchQuery(toolCall.function?.arguments) },
        type: 'web_search',
      };
};

export interface ServerToolRunResult {
  /** Text handed back upstream as the tool's result message. */
  content: string;
  execution: ServerToolExecution;
  tool_call_id: string;
}

/**
 * Runs every invocation and returns one tool message per call.
 *
 * Failures become text rather than exceptions: the arguments came from the
 * model, so the useful outcome is for it to see what went wrong and retry or
 * answer without the findings — not for the whole turn to fail.
 */
export const executeServerToolInvocations = async ({
  fetchProvider,
  invocations,
  onCall,
  onResult,
  searchProvider,
}: {
  fetchProvider: WebFetchProvider | null;
  invocations: ServerToolInvocation[];
  onCall?: (invocation: ServerToolInvocation) => void;
  onResult?: (execution: ServerToolExecution) => void;
  searchProvider: WebSearchProvider | null;
}): Promise<ServerToolRunResult[]> => {
  return await Promise.all(
    invocations.map(async (invocation) => {
      // Announced before the call runs, so a client watching the stream sees
      // the search start rather than only its result.
      onCall?.(invocation);

      if (invocation.type === 'web_fetch') {
        const result = await runWebFetchResult({
          provider: fetchProvider,
          query: invocation.input,
        });
        const execution: ServerToolExecution = { ...invocation, result };

        onResult?.(execution);

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

      onResult?.(execution);

      return {
        content: result.content,
        execution,
        tool_call_id: invocation.id,
      };
    }),
  );
};
