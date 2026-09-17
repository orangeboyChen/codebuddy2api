// ---------------------------------------------------------------------------
// /v1/responses route entry point
//
// The machinery this route relies on lives in the sibling modules:
//
//   responses-types      shared type declarations
//   responses-session    session persistence
//   responses-tools      Responses <-> Chat tool translation
//   responses-transcript transcript construction and usage mapping
//   responses-payload    non-streaming payload assembly
//   responses-stream     SSE stream mapping
// ---------------------------------------------------------------------------

import type { NextRequest } from 'next/server';

import { getDefaultModel } from '../domain/config';
import { getCredentialSupportedModels } from '../domain/credentials';
import type { DebugTrace } from '../domain/debug';
import { createErrorResponse } from '../shared/http';
import { resolveRequestAccessKey } from './auth';
import {
  proxyChatCompletions,
  proxyResponsesUpstream,
  resolveProxyContext,
  resolveProxyContextByCredentialFilename,
} from './codebuddy';
import { executeImageGenerationLoop } from './image-generation';
import { mapChatResponseToResponsesPayload } from './responses/payload';
import {
  getResponseSession,
  getValidatedPreviousSession,
  storeUpstreamResponseBinding,
} from './responses/session';
import { createResponsesEventStream } from './responses/event-stream';
import {
  getResponsesCompatibilityError,
  hasImageGenerationTool,
  normalizeTranscriptMessageToolNames,
  translateResponsesToolsToChat,
  translateResponsesToolChoiceToChatWithTools,
} from './responses/tools';
import { prepareTranscript } from './responses/transcript';
import type { ResponsesRequestBody } from './responses/types';
import { getServerToolExecutions } from './web-search-loop';

export const handleResponsesRequest = async (
  request: NextRequest,
  body: ResponsesRequestBody,
  debugTrace?: DebugTrace,
): Promise<Response> => {
  try {
    const previousResponseId = body.previous_response_id ?? null;
    const accessKey = await resolveRequestAccessKey(request);
    const storedPreviousSession = previousResponseId
      ? await getResponseSession(previousResponseId)
      : undefined;

    if (
      previousResponseId &&
      storedPreviousSession &&
      storedPreviousSession.accessKeyId !== (accessKey?.id ?? null)
    ) {
      throw new Error('Unknown or expired previous_response_id');
    }

    if (
      storedPreviousSession?.credentialFilename &&
      accessKey?.credentialFilenames?.length &&
      !accessKey.credentialFilenames.includes(
        storedPreviousSession.credentialFilename,
      )
    ) {
      throw new Error('Unknown or expired previous_response_id');
    }

    const resolvedProxyContext = storedPreviousSession?.credentialFilename
      ? await resolveProxyContextByCredentialFilename(
          storedPreviousSession.credentialFilename,
          {
            accessKey: accessKey
              ? {
                  id: accessKey.id,
                  name: accessKey.name,
                }
              : undefined,
            allowedCredentialFilenames: accessKey?.credentialFilenames,
            requireEligible: true,
          },
        )
      : await resolveProxyContext(
          request,
          typeof body.model === 'string' ? body.model : undefined,
        );
    const proxyContext = storedPreviousSession?.upstreamProtocol
      ? {
          ...resolvedProxyContext,
          preferences: {
            ...resolvedProxyContext.preferences,
            upstreamProtocol: storedPreviousSession.upstreamProtocol,
          },
        }
      : resolvedProxyContext;

    const scopedBody =
      typeof body.model !== 'string' || !body.model.trim()
        ? {
            ...body,
            model:
              storedPreviousSession?.model ??
              getCredentialSupportedModels(
                proxyContext.auth.credentialData,
              )[0] ??
              (await getDefaultModel()),
          }
        : body;

    if (proxyContext.preferences.upstreamProtocol === 'responses') {
      const model = String(
        (scopedBody as ResponsesRequestBody).model ?? 'unknown',
      );
      return proxyResponsesUpstream(
        request,
        scopedBody as Record<string, unknown>,
        proxyContext,
        debugTrace,
        async (responseId) => {
          await storeUpstreamResponseBinding({
            model,
            proxyContext,
            responseId,
          });
        },
      );
    }

    const previousSession = await getValidatedPreviousSession(
      previousResponseId,
      accessKey?.id ?? null,
    );

    const prepared = await prepareTranscript(
      scopedBody,
      proxyContext.accessKeyId,
      previousSession,
    );
    const compatibilityError = getResponsesCompatibilityError(
      prepared.defaults.tools,
      prepared.defaults.tool_choice,
    );

    if (compatibilityError) {
      return compatibilityError;
    }

    if (body.stream) {
      return await createResponsesEventStream(
        request,
        prepared.defaults,
        prepared.transcript,
        prepared.model,
        prepared.previousResponseId,
        body.max_output_tokens,
        proxyContext,
        debugTrace,
      );
    }

    const chatBody = {
      model: prepared.model,
      messages: [
        ...(prepared.defaults.instructions
          ? [{ role: 'system', content: prepared.defaults.instructions }]
          : []),
        ...normalizeTranscriptMessageToolNames(
          prepared.transcript,
          prepared.defaults.tools,
        ),
      ],
      max_tokens: body.max_output_tokens,
      stream: false,
      tools: translateResponsesToolsToChat(prepared.defaults.tools),
      tool_choice: translateResponsesToolChoiceToChatWithTools(
        prepared.defaults.tools,
        prepared.defaults.tool_choice,
      ),
    };

    // Image generation has no chat-protocol equivalent, so the model's call is
    // executed here and replayed with the image folded in. Only meaningful when
    // the tool was actually declared; otherwise the loop returns null and the
    // ordinary upstream call runs.
    if (hasImageGenerationTool(prepared.defaults.tools)) {
      const {
        executions,
        response: imageResponse,
        serverToolExecutions,
      } = await executeImageGenerationLoop({
        body: chatBody,
        callUpstream: (loopBody) =>
          proxyChatCompletions(
            request,
            loopBody as never,
            proxyContext,
            debugTrace,
            '/v1/responses',
          ),
        context: proxyContext,
        request,
      });

      // Always consumed: the loop has already sent the turn upstream, and
      // re-issuing it would bill twice and could return a different answer.
      if (!imageResponse.ok) {
        return imageResponse;
      }

      const imagePayload = (await imageResponse.json()) as Record<
        string,
        unknown
      >;

      return Response.json(
        await mapChatResponseToResponsesPayload(
          proxyContext.accessKeyId,
          proxyContext.credentialFilename,
          prepared.defaults,
          prepared.transcript,
          prepared.model,
          prepared.previousResponseId,
          imagePayload,
          // Read off the loop, not the response: the loop rebuilds it, so
          // nothing is keyed under this response object any more.
          serverToolExecutions,
          executions,
        ),
      );
    }

    const upstreamResponse = await proxyChatCompletions(
      request,
      chatBody as never,
      proxyContext,
      debugTrace,
      '/v1/responses',
    );

    if (!upstreamResponse.ok) {
      return upstreamResponse;
    }

    const upstreamPayload = (await upstreamResponse.json()) as Record<
      string,
      unknown
    >;
    const serverToolExecutions = getServerToolExecutions(upstreamResponse);

    return Response.json(
      await mapChatResponseToResponsesPayload(
        proxyContext.accessKeyId,
        proxyContext.credentialFilename,
        prepared.defaults,
        prepared.transcript,
        prepared.model,
        prepared.previousResponseId,
        upstreamPayload,
        serverToolExecutions,
      ),
    );
  } catch (error) {
    console.error('[CodeBuddy2API] Responses request failed', {
      route: '/v1/responses',
      error,
    });
    return createErrorResponse(
      error instanceof Error && error.message.includes('previous_response_id')
        ? 400
        : error instanceof Error &&
            error.message.includes('Response session exceeds')
          ? 413
          : 500,
      error instanceof Error ? error.message : 'Unexpected responses error',
    );
  }
};

export { translateResponsesToolsToChat } from './responses/tools';
export { resetResponseSessions } from './responses/session';
