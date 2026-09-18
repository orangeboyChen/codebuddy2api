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
import { withCodeBuddyToken } from '../search/token';
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
import {
  getServerToolExecutions,
  hasExecutableServerTool,
  prepareServerToolTurn,
  reconcileToolChoice,
  runServerToolTurn,
  type ServerToolSegment,
} from './server-tools';

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

    const translatedTools = translateResponsesToolsToChat(
      prepared.defaults.tools,
    );

    // Classified on the translated tools, which keep a provider-executed
    // declaration's type. A client's own function — including one named
    // `web_search` — arrives as `function` and stays the client's to resolve.
    const serverTools = await prepareServerToolTurn(translatedTools);
    const rewrite = serverTools?.rewrite ?? null;
    const willRunServerTool = Boolean(
      rewrite && hasExecutableServerTool(rewrite.executable),
    );

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
      // Rewritten even when nothing will be executed: upstream has no server
      // tools, so a declared type would be a shape it rejects.
      tools: rewrite ? rewrite.tools : translatedTools,
      // A server tool nothing here can run is withdrawn from `tools`, so a
      // choice forcing it has to go too.
      tool_choice: reconcileToolChoice(
        translateResponsesToolChoiceToChatWithTools(
          prepared.defaults.tools,
          prepared.defaults.tool_choice,
        ),
        rewrite ? rewrite.tools : translatedTools,
      ),
    };

    /**
     * One hop upstream, running any server tool the model asks for on the way.
     *
     * Both branches are needed because the turn only exists when something is
     * executable; otherwise the request goes upstream as it stands, with every
     * tool call coming back to the client.
     */
    // What the model wrote before its first search. The image loop drives
    // upstream through `callUpstream`, so the preamble has to be captured
    // here rather than at a single call site.
    let turnSegments: ServerToolSegment[] | undefined;

    const callUpstream = async (
      loopBody: Record<string, unknown>,
      stream: boolean,
    ): Promise<Response> => {
      if (!willRunServerTool || !rewrite) {
        return proxyChatCompletions(
          request,
          { ...loopBody, stream } as never,
          proxyContext,
          debugTrace,
          '/v1/responses',
        );
      }

      const outcome = await withCodeBuddyToken(
        () => Promise.resolve(proxyContext.auth.bearerToken),
        () =>
          runServerToolTurn({
            body: loopBody as never,
            callUpstream: (turnBody, turnStream) =>
              proxyChatCompletions(
                request,
                { ...turnBody, stream: turnStream } as never,
                proxyContext,
                debugTrace,
                '/v1/responses',
              ),
            fetchProvider: serverTools!.providers.fetchProvider,
            rewrite,
            searchProvider: serverTools!.providers.searchProvider,
            signal: request.signal,
          }),
      );

      // Accumulated across iterations: the image loop calls this once per
      // iteration and each outcome carries only that iteration's segments, so
      // first-wins would drop every search after the first. An iteration that
      // ran no server tool contributes an empty array and erases nothing, and
      // `undefined` still means none ran at all — the mapper falls back to
      // `serverToolExecutions` on that distinction.
      if (outcome.segments.length) {
        turnSegments = [...(turnSegments ?? []), ...outcome.segments];
      }

      return outcome.response;
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
        // Buffered so the tool call can be inspected before any delta reaches
        // the client. Any server tool the hop asked for runs inside this call.
        callUpstream: (loopBody) => callUpstream(loopBody, false),
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
          undefined,
          turnSegments,
        ),
      );
    }

    const upstreamResponse = await callUpstream(chatBody, false);

    if (!upstreamResponse.ok) {
      return upstreamResponse;
    }

    const upstreamPayload = (await upstreamResponse.json()) as Record<
      string,
      unknown
    >;
    // Read off the response rather than returned by the call: a turn rebuilds
    // the response, and the image-generation loop above drives upstream itself,
    // so a returned field would have to be threaded through every layer in
    // between.
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
        [],
        undefined,
        turnSegments,
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
