import type { NextRequest } from 'next/server';

import type { DebugTrace } from '../domain/debug';
import { withCodeBuddyToken } from '../search/token';
import {
  anthropicErrorType,
  createAnthropicError,
  getUpstreamErrorMessage,
} from './anthropic/errors';
import { buildChatRequestBody } from './anthropic/request';
import { mapOpenAIResponseToAnthropic } from './anthropic/response';
import {
  createAnthropicServerToolEventStream,
  mapOpenAIStreamToAnthropicSSE,
} from './anthropic/stream';
import type {
  AnthropicMessagesRequestBody,
  OpenAIChatResponse,
} from './anthropic/types';
import {
  proxyChatCompletions,
  resolveProxyContext,
  type ChatRequestBody,
  type ProxyContext,
} from './codebuddy';
import {
  hasExecutableServerTool,
  prepareServerToolTurn,
  runServerToolTurn,
} from './server-tools';

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export const handleMessagesRequest = async (
  request: NextRequest,
  body: AnthropicMessagesRequestBody,
  debugTrace?: DebugTrace,
): Promise<Response> => {
  if (!body.messages?.length) {
    return createAnthropicError(400, 'messages is required');
  }

  try {
    const chatBody = await buildChatRequestBody(body);
    const model = String(chatBody.model ?? 'unknown');

    // Classified on the translated tools: the translator keeps a
    // provider-executed declaration's type, so `web_search_20250305` is still
    // recognisable here, while the client's own `WebSearch` has become an
    // ordinary function and is left alone.
    const prepared = await prepareServerToolTurn(chatBody.tools);
    const rewrite = prepared?.rewrite ?? null;

    // The declarations have to be rewritten even when nothing is executed:
    // upstream has no server tools, so leaving `web_search_20250305` in the
    // request would send a shape it rejects. A declaration the proxy is not
    // running becomes an ordinary function, and the call that comes back goes
    // to the client.
    const upstreamTools = rewrite
      ? rewrite.tools
      : ((chatBody.tools as unknown[] | undefined) ?? undefined);

    const callUpstream =
      (context?: ProxyContext) =>
      (turnBody: ChatRequestBody, stream: boolean): Promise<Response> =>
        proxyChatCompletions(
          request,
          { ...turnBody, tools: upstreamTools, stream },
          context,
          debugTrace,
          '/v1/messages',
        );

    if (rewrite && prepared && hasExecutableServerTool(rewrite.executable)) {
      const { fetchProvider, searchProvider } = prepared.providers;

      // Resolved here rather than inside the call so the CodeBuddy backends can
      // be scoped to this request's credential: they call the agent-tool
      // endpoints with the same token the model call used.
      const context = await resolveProxyContext(
        request,
        typeof chatBody.model === 'string' ? chatBody.model : undefined,
      );

      const runTurn = () =>
        withCodeBuddyToken(
          () => Promise.resolve(context.auth.bearerToken),
          () =>
            runServerToolTurn({
              body: { ...chatBody, tools: rewrite.tools } as ChatRequestBody,
              callUpstream: callUpstream(context),
              fetchProvider,
              rewrite,
              searchProvider,
              stream: Boolean(body.stream),
            }),
        );

      if (body.stream) {
        return createAnthropicServerToolEventStream({ model, runTurn });
      }

      const { executions, preamble, response } = await runTurn();

      if (!response.ok) {
        return createAnthropicError(
          response.status,
          await getUpstreamErrorMessage(response),
        );
      }

      const payload = (await response.json()) as OpenAIChatResponse;

      return Response.json(
        mapOpenAIResponseToAnthropic(payload, model, executions, preamble),
      );
    }

    const upstreamResponse = await callUpstream()(
      chatBody as ChatRequestBody,
      Boolean(body.stream),
    );

    if (!upstreamResponse.ok) {
      return createAnthropicError(
        upstreamResponse.status,
        await getUpstreamErrorMessage(upstreamResponse),
      );
    }

    if (body.stream) {
      return mapOpenAIStreamToAnthropicSSE(upstreamResponse, model);
    }

    const payload = (await upstreamResponse.json()) as OpenAIChatResponse;

    return Response.json(mapOpenAIResponseToAnthropic(payload, model));
  } catch (error) {
    return createAnthropicError(
      500,
      error instanceof Error ? error.message : 'Unexpected messages error',
    );
  }
};

// Re-exported for the importers that reached these through this module before
// the split: `app/v1/messages/route.ts` and the test suite.
export { anthropicErrorType, createAnthropicError };
