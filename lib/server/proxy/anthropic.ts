import type { NextRequest } from 'next/server';

import type { DebugTrace } from '../domain/debug';
import {
  anthropicErrorType,
  createAnthropicError,
  getUpstreamErrorMessage,
} from './anthropic-errors';
import {
  buildChatRequestBody,
  shouldBridgeAnthropicServerTools,
} from './anthropic-request';
import { mapOpenAIResponseToAnthropic } from './anthropic-response';
import {
  createAnthropicServerToolEventStream,
  mapOpenAIStreamToAnthropicSSE,
} from './anthropic-stream';
import type {
  AnthropicMessagesRequestBody,
  OpenAIChatResponse,
} from './anthropic-types';
import { proxyChatCompletions, type ChatRequestBody } from './codebuddy';
import { getServerToolExecutions, getServerToolTurns } from './web-search-loop';

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

    if (body.stream && (await shouldBridgeAnthropicServerTools(body.tools))) {
      return createAnthropicServerToolEventStream(
        request,
        chatBody,
        String(chatBody.model ?? 'unknown'),
        debugTrace,
      );
    }

    const upstreamResponse = await proxyChatCompletions(
      request,
      chatBody as ChatRequestBody,
      undefined,
      debugTrace,
      '/v1/messages',
      { findingsAsStructuredBlocks: true },
    );

    if (!upstreamResponse.ok) {
      return createAnthropicError(
        upstreamResponse.status,
        await getUpstreamErrorMessage(upstreamResponse),
      );
    }

    const model = String(chatBody.model ?? 'unknown');
    const serverToolExecutions = getServerToolExecutions(upstreamResponse);
    // Carried beside the response rather than inside it: the OpenAI-shaped
    // payload the loop emits must stay protocol-clean for chat-completions
    // clients, so this file reads the grouping off the response itself.
    const turns = getServerToolTurns(upstreamResponse);

    if (body.stream) {
      return mapOpenAIStreamToAnthropicSSE(upstreamResponse, model);
    }

    const payload = (await upstreamResponse.json()) as OpenAIChatResponse;

    return Response.json(
      mapOpenAIResponseToAnthropic(payload, model, serverToolExecutions, turns),
    );
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
