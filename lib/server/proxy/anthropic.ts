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
  reconcileToolChoice,
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

    /**
     * One round trip upstream.
     *
     * The tools come from `turnBody`, never pinned back on here: the turn
     * decides what to offer on each hop, and overriding it would undo the
     * withdrawal it does once the search budget is spent.
     */
    const callUpstream =
      (context?: ProxyContext) =>
      (turnBody: ChatRequestBody, stream: boolean): Promise<Response> =>
        proxyChatCompletions(
          request,
          { ...turnBody, stream },
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
            }),
        );

      if (body.stream) {
        return createAnthropicServerToolEventStream({ model, runTurn });
      }

      const { executions, response, segments } = await runTurn();

      if (!response.ok) {
        return createAnthropicError(
          response.status,
          await getUpstreamErrorMessage(response),
        );
      }

      const payload = (await response.json()) as OpenAIChatResponse;

      return Response.json(
        mapOpenAIResponseToAnthropic(payload, model, executions, segments),
      );
    }

    const upstreamResponse = await callUpstream()(
      // `upstreamTools` matters here even though no turn runs: when a server
      // tool is declared but nothing on this deployment can execute it, the
      // declaration still has to be rewritten, or upstream is sent a
      // `web_search_20250305` type it has never heard of.
      {
        ...chatBody,
        tools: upstreamTools,
        // A server tool nothing here can run is withdrawn from `tools`, so a
        // choice forcing it has to go too.
        tool_choice: reconcileToolChoice(chatBody.tool_choice, upstreamTools),
      } as ChatRequestBody,
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
