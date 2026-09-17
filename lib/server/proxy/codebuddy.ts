import type { NextRequest } from 'next/server';

import {
  aggregateUpstreamStream,
  normalizeStreamingResponse,
} from './codebuddy-chat-stream';
import { resolveProxyContext } from './codebuddy-context';
import {
  buildResponsesBodyFromChat,
  getUnsupportedResponsesChatOptions,
  normalizeResponsesUpstreamBody,
} from './codebuddy-responses-request';
import {
  mapResponsesPayloadToChat,
  mapResponsesStreamToChat,
} from './codebuddy-responses-response';
import { detectServerToolStream } from './codebuddy-server-tools';
import {
  SERVER_WEB_TOOL_NAMES,
  type ChatRequestBody,
  type ProxyContext,
} from './codebuddy-types';
import {
  extractResponsesId,
  extractResponsesUsage,
  logUpstreamFailure,
  parseUsageHeader,
  recordProxyUsage,
} from './codebuddy-usage';
import { trackResponsesUsageStream } from './codebuddy-usage-stream';
import {
  buildUpstreamBody,
  buildUpstreamHeaders,
  headersToRecord,
} from './codebuddy-upstream';
import {
  enqueueUpstreamResponseSnapshot,
  setDebugTraceCredential,
  setDebugTraceError,
  setDebugUpstreamRequest,
  type DebugTrace,
} from '../domain/debug';
import {
  getApiFirstDeltaTimeoutMs,
  getCodeBuddyApiEndpoint,
  getDefaultModel,
} from '../domain/config';
import { withCodeBuddyToken } from '../search/token';
import {
  normalizeToolName,
  WEB_FETCH_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
} from '../search/tool';
import { createErrorResponse } from '../shared/http';
import { fetchWithDeadline } from '../shared/upstream-timeout';
import {
  attachServerToolExecutions,
  attachServerToolTurns,
  type ChatCompletionPayload,
  executeWebSearchLoop,
  type ServerToolCallbacks,
  synthesizeChatCompletionStream,
} from './web-search-loop';

/**
 * One round trip to `/v2/chat/completions`. Split out from
 * `proxyChatCompletions` so the local web search loop can re-issue the request
 * with tool results appended without re-deriving auth, headers, or usage
 * recording on each iteration.
 *
 * Upstream is always asked to stream; `stream` only controls the shape handed
 * back to the caller, so it must echo what the client asked for rather than
 * being read off `upstreamBody`.
 */
const fetchChatCompletion = async ({
  body,
  debugTrace,
  request,
  resolvedContext,
  stream,
  upstreamBody: providedUpstreamBody,
  usageRoute,
}: {
  body: ChatRequestBody;
  debugTrace?: DebugTrace;
  request: NextRequest;
  resolvedContext: ProxyContext;
  /**
   * Whether the caller wants an SSE stream back. Upstream is always asked to
   * stream regardless — it rejects `stream: false` with code 11101 — so this
   * only chooses between passing the stream through and buffering it into a
   * single JSON payload.
   */
  stream: boolean;
  upstreamBody?: ChatRequestBody;
  usageRoute: string;
}): Promise<Response> => {
  const apiEndpoint = await getCodeBuddyApiEndpoint();
  const upstreamUrl = `${apiEndpoint}/v2/chat/completions`;
  const upstreamHeaders = await buildUpstreamHeaders(
    request,
    resolvedContext.auth,
  );
  const upstreamBody =
    providedUpstreamBody ?? (await buildUpstreamBody(body, resolvedContext));

  setDebugUpstreamRequest(debugTrace, {
    body: upstreamBody,
    headers: headersToRecord(upstreamHeaders),
    method: 'POST',
    url: upstreamUrl,
  });

  const upstream = await fetchWithDeadline({
    body: JSON.stringify(upstreamBody),
    headers: upstreamHeaders,
    onTimeout: (error) => setDebugTraceError(debugTrace, error),
    timeoutMs: await getApiFirstDeltaTimeoutMs(),
    url: upstreamUrl,
  });

  if (!upstream.ok) {
    return upstream.response;
  }

  const upstreamResponse = enqueueUpstreamResponseSnapshot(
    debugTrace,
    upstream.response,
  );

  if (!upstreamResponse.ok) {
    const detail = await upstreamResponse.text();
    logUpstreamFailure({
      detail,
      route: '/v1/chat/completions',
      status: upstreamResponse.status,
      url: upstreamUrl,
    });
    setDebugTraceError(debugTrace, detail);
    return createErrorResponse(
      upstreamResponse.status,
      'Upstream CodeBuddy request failed',
      detail,
    );
  }

  const contentType = upstreamResponse.headers.get('content-type') ?? '';

  if (stream && !contentType.toLowerCase().includes('application/json')) {
    return normalizeStreamingResponse({
      model: String(upstreamBody.model ?? 'unknown'),
      proxyContext: resolvedContext,
      route: usageRoute,
      upstreamResponse,
    });
  }

  // Upstream only accepts `stream: true`, so a non-streaming caller is served
  // by buffering the SSE response and folding it into a single JSON payload.
  if (contentType.toLowerCase().includes('application/json')) {
    const payloadText = await upstreamResponse.text();
    let usage: unknown = null;

    try {
      usage = (JSON.parse(payloadText) as { usage?: unknown }).usage ?? null;
    } catch {
      usage = null;
    }

    await recordProxyUsage({
      model: String(upstreamBody.model ?? 'unknown'),
      proxyContext: resolvedContext,
      route: usageRoute,
      usage,
    });

    return new Response(payloadText, {
      status: upstreamResponse.status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
      },
    });
  }

  const aggregated = await aggregateUpstreamStream(
    upstreamResponse,
    String(upstreamBody.model ?? 'unknown'),
  );

  await recordProxyUsage({
    model: aggregated.model,
    proxyContext: resolvedContext,
    route: usageRoute,
    usage: aggregated.usage,
  });

  return aggregated.response;
};

export const proxyChatCompletions = async (
  request: NextRequest,
  body: ChatRequestBody,
  context?: ProxyContext,
  debugTrace?: DebugTrace,
  usageRoute = '/v1/chat/completions',
  serverToolCallbacks?: ServerToolCallbacks,
): Promise<Response> => {
  if (!body.messages?.length) {
    return createErrorResponse(400, 'messages is required');
  }

  try {
    const resolvedContext =
      context ?? (await resolveProxyContext(request, body.model));
    setDebugTraceCredential(debugTrace, resolvedContext.credentialFilename);
    let upstreamBody = await buildUpstreamBody(body, resolvedContext);

    // Server-side web tools run on the chat path only. The Responses
    // passthrough path forwards to CodeBuddy's own /responses endpoint, where
    // re-issuing a request with a synthesized tool result would mean replaying
    // the whole conversation through a different protocol for each iteration.
    if (resolvedContext.preferences.upstreamProtocol === 'chat') {
      const webSearch = await withCodeBuddyToken(
        // The CodeBuddy backends call the agent-tool endpoints with the same
        // credential as this request, so the loop is scoped to it. Resolved
        // lazily: a token is only needed when a CodeBuddy backend actually runs.
        () => Promise.resolve(resolvedContext.auth.bearerToken),
        () =>
          executeWebSearchLoop({
            body: upstreamBody,
            callbacks: serverToolCallbacks,
            callUpstream: async (loopBody, mode) => {
              const upstreamResponse = await fetchChatCompletion({
                body: loopBody,
                debugTrace,
                request,
                resolvedContext,
                // Probe the first meaningful SSE delta for streaming callers.
                // Ordinary content stays live; only a server-tool call is
                // buffered into a payload the execution loop can inspect.
                stream: mode !== 'buffer',
                // Already normalized, so pass it straight through; re-running
                // buildUpstreamBody each iteration would re-apply prompt cache
                // markers to the appended tool results.
                upstreamBody: { ...loopBody, stream: true },
                usageRoute,
              });

              const detectedNames =
                mode === 'detect-both'
                  ? SERVER_WEB_TOOL_NAMES
                  : mode === 'detect-search'
                    ? [normalizeToolName(WEB_SEARCH_TOOL_NAME)]
                    : [normalizeToolName(WEB_FETCH_TOOL_NAME)];

              if (mode === 'stream' || mode === 'buffer') {
                return upstreamResponse;
              }

              return detectServerToolStream(
                upstreamResponse,
                String(loopBody.model ?? 'unknown'),
                detectedNames,
              );
            },
            detectInitialStream: Boolean(body.stream),
          }),
      );

      // No tool could be executed, so the loop declined to run. Its rewritten
      // `tools` still matter: unsupported server-tool declarations have been
      // stripped, and continuing with them keeps the request valid upstream
      // instead of forwarding a declaration it would reject.
      if (webSearch && !webSearch.response) {
        upstreamBody = webSearch.body;
      }

      if (webSearch?.response) {
        // The hop grouping rides beside the response rather than inside its
        // body, so the OpenAI-shaped payload a chat client receives stays
        // protocol-clean. See `attachServerToolTurns`.
        const attachServerToolResult = (response: Response): Response =>
          attachServerToolTurns(
            attachServerToolExecutions(response, webSearch.executions),
            webSearch.turns,
          );

        if (!webSearch.response.ok) {
          return attachServerToolResult(webSearch.response);
        }

        if (
          body.stream &&
          !webSearch.response.headers
            .get('content-type')
            ?.toLowerCase()
            .includes('text/event-stream')
        ) {
          return attachServerToolResult(
            synthesizeChatCompletionStream(
              (await webSearch.response.json()) as ChatCompletionPayload,
              String(upstreamBody.model ?? 'unknown'),
            ),
          );
        }

        return attachServerToolResult(webSearch.response);
      }
    }

    if (resolvedContext.preferences.upstreamProtocol === 'responses') {
      const unsupportedOptions = getUnsupportedResponsesChatOptions(body);
      if (unsupportedOptions.length) {
        return createErrorResponse(
          400,
          `Unsupported Chat options for Responses upstream: ${unsupportedOptions.join(', ')}`,
        );
      }
      const apiEndpoint = await getCodeBuddyApiEndpoint();
      const upstreamUrl = `${apiEndpoint}/responses`;
      const upstreamHeaders = new Headers(
        await buildUpstreamHeaders(request, resolvedContext.auth),
      );
      const responsesBody = {
        ...(await buildResponsesBodyFromChat(upstreamBody)),
        stream: Boolean(body.stream),
      };

      setDebugUpstreamRequest(debugTrace, {
        body: responsesBody,
        headers: headersToRecord(upstreamHeaders),
        method: 'POST',
        url: upstreamUrl,
      });

      const upstream = await fetchWithDeadline({
        body: JSON.stringify(responsesBody),
        headers: upstreamHeaders,
        onTimeout: (error) => setDebugTraceError(debugTrace, error),
        timeoutMs: await getApiFirstDeltaTimeoutMs(),
        url: upstreamUrl,
      });

      if (!upstream.ok) {
        return upstream.response;
      }

      const upstreamResponse = enqueueUpstreamResponseSnapshot(
        debugTrace,
        upstream.response,
      );

      if (!upstreamResponse.ok) {
        const detail = await upstreamResponse.text();
        logUpstreamFailure({
          detail,
          route: usageRoute,
          status: upstreamResponse.status,
          url: upstreamUrl,
        });
        setDebugTraceError(debugTrace, detail);
        return createErrorResponse(
          upstreamResponse.status,
          'Upstream CodeBuddy request failed',
          detail,
        );
      }

      if (body.stream) {
        return mapResponsesStreamToChat(
          upstreamResponse,
          String(upstreamBody.model ?? 'unknown'),
          resolvedContext,
          usageRoute,
          body.stop,
          Boolean(body.stream_options?.include_usage) ||
            usageRoute === '/v1/messages',
        );
      }

      const payload = (await upstreamResponse.json()) as Record<
        string,
        unknown
      >;
      await recordProxyUsage({
        model: String(upstreamBody.model ?? 'unknown'),
        proxyContext: resolvedContext,
        route: usageRoute,
        usage: payload.usage ?? null,
      });
      if (payload.status === 'failed' || payload.error) {
        const error =
          payload.error && typeof payload.error === 'object'
            ? (payload.error as { message?: unknown })
            : undefined;
        return createErrorResponse(
          502,
          typeof error?.message === 'string'
            ? error.message
            : 'Upstream Responses request failed',
          payload.error,
        );
      }
      return Response.json(
        mapResponsesPayloadToChat(
          payload,
          String(upstreamBody.model ?? 'unknown'),
          body.stop,
        ),
      );
    }

    const apiEndpoint = await getCodeBuddyApiEndpoint();
    const upstreamUrl = `${apiEndpoint}/v2/chat/completions`;
    const upstreamHeaders = await buildUpstreamHeaders(
      request,
      resolvedContext.auth,
    );

    setDebugUpstreamRequest(debugTrace, {
      body: upstreamBody,
      headers: headersToRecord(upstreamHeaders),
      method: 'POST',
      url: upstreamUrl,
    });

    const upstream = await fetchWithDeadline({
      body: JSON.stringify(upstreamBody),
      headers: upstreamHeaders,
      onTimeout: (error) => setDebugTraceError(debugTrace, error),
      timeoutMs: await getApiFirstDeltaTimeoutMs(),
      url: upstreamUrl,
    });

    if (!upstream.ok) {
      return upstream.response;
    }

    const upstreamResponse = enqueueUpstreamResponseSnapshot(
      debugTrace,
      upstream.response,
    );

    if (!upstreamResponse.ok) {
      const detail = await upstreamResponse.text();
      logUpstreamFailure({
        detail,
        route: '/v1/chat/completions',
        status: upstreamResponse.status,
        url: upstreamUrl,
      });
      setDebugTraceError(debugTrace, detail);
      return createErrorResponse(
        upstreamResponse.status,
        'Upstream CodeBuddy request failed',
        detail,
      );
    }

    if (body.stream) {
      return normalizeStreamingResponse({
        model: String(upstreamBody.model ?? 'unknown'),
        proxyContext: resolvedContext,
        route: usageRoute,
        upstreamResponse,
      });
    }

    const contentType = upstreamResponse.headers.get('content-type') ?? '';

    if (contentType.toLowerCase().includes('application/json')) {
      const payloadText = await upstreamResponse.text();
      let usage: unknown = null;

      try {
        usage = (JSON.parse(payloadText) as { usage?: unknown }).usage ?? null;
      } catch {
        usage = null;
      }

      await recordProxyUsage({
        model: String(upstreamBody.model ?? 'unknown'),
        proxyContext: resolvedContext,
        route: usageRoute,
        usage,
      });

      return new Response(payloadText, {
        status: upstreamResponse.status,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
        },
      });
    }

    const aggregated = await aggregateUpstreamStream(
      upstreamResponse,
      String(upstreamBody.model ?? 'unknown'),
    );

    await recordProxyUsage({
      model: aggregated.model,
      proxyContext: resolvedContext,
      route: usageRoute,
      usage: aggregated.usage,
    });

    return aggregated.response;
  } catch (error) {
    setDebugTraceError(debugTrace, error);
    logUpstreamFailure({
      error,
      route: '/v1/chat/completions',
      url: `${await getCodeBuddyApiEndpoint()}/v2/chat/completions`,
    });
    return createErrorResponse(
      500,
      error instanceof Error ? error.message : 'Unexpected upstream error',
    );
  }
};

export const proxyResponsesUpstream = async (
  request: NextRequest,
  body: Record<string, unknown>,
  context?: ProxyContext,
  debugTrace?: DebugTrace,
  onResponseId?: (responseId: string) => Promise<void>,
): Promise<Response> => {
  try {
    const resolvedContext =
      context ??
      (await resolveProxyContext(
        request,
        typeof body.model === 'string' ? body.model : undefined,
      ));
    setDebugTraceCredential(debugTrace, resolvedContext.credentialFilename);
    const upstreamBody = {
      ...(await normalizeResponsesUpstreamBody(body)),
      model:
        typeof body.model === 'string' && body.model.trim()
          ? body.model
          : await getDefaultModel(),
    };
    const apiEndpoint = await getCodeBuddyApiEndpoint();
    const upstreamUrl = `${apiEndpoint}/responses`;
    const upstreamHeaders = new Headers(
      await buildUpstreamHeaders(request, resolvedContext.auth),
    );

    setDebugUpstreamRequest(debugTrace, {
      body: upstreamBody,
      headers: headersToRecord(upstreamHeaders),
      method: 'POST',
      url: upstreamUrl,
    });

    const upstream = await fetchWithDeadline({
      body: JSON.stringify(upstreamBody),
      headers: upstreamHeaders,
      onTimeout: (error) => {
        setDebugTraceError(debugTrace, error);
        logUpstreamFailure({
          error,
          route: '/v1/responses',
          url: upstreamUrl,
        });
      },
      timeoutMs: await getApiFirstDeltaTimeoutMs(),
      url: upstreamUrl,
    });

    if (!upstream.ok) {
      return upstream.response;
    }

    const upstreamResponse = enqueueUpstreamResponseSnapshot(
      debugTrace,
      upstream.response,
    );

    if (!upstreamResponse.ok) {
      const detail = await upstreamResponse.text();
      logUpstreamFailure({
        detail,
        route: '/v1/responses',
        status: upstreamResponse.status,
        url: upstreamUrl,
      });
      setDebugTraceError(debugTrace, detail);
      return createErrorResponse(
        upstreamResponse.status,
        'Upstream CodeBuddy request failed',
        detail,
      );
    }

    const model = String(upstreamBody.model ?? 'unknown');
    const fallbackUsage = parseUsageHeader(upstreamResponse);

    const contentType = upstreamResponse.headers.get('content-type') ?? '';

    if (contentType.toLowerCase().includes('application/json')) {
      const payloadText = await upstreamResponse.text();
      let usage = fallbackUsage;
      let responseId: string | null = null;

      try {
        const payload = JSON.parse(payloadText) as unknown;
        usage = extractResponsesUsage(payload) ?? fallbackUsage;
        responseId = extractResponsesId(payload);
      } catch {
        // Preserve malformed upstream JSON while retaining header usage.
      }

      if (responseId && onResponseId) {
        await onResponseId(responseId);
      }

      await recordProxyUsage({
        model,
        proxyContext: resolvedContext,
        route: '/v1/responses',
        usage,
      });

      return new Response(payloadText, {
        headers: upstreamResponse.headers,
        status: upstreamResponse.status,
      });
    }

    if (contentType.toLowerCase().includes('text/event-stream')) {
      return trackResponsesUsageStream({
        fallbackUsage,
        model,
        onResponseId,
        proxyContext: resolvedContext,
        upstreamResponse,
      });
    }

    await recordProxyUsage({
      model,
      proxyContext: resolvedContext,
      route: '/v1/responses',
      usage: fallbackUsage,
    });

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: upstreamResponse.headers,
    });
  } catch (error) {
    setDebugTraceError(debugTrace, error);
    logUpstreamFailure({
      error,
      route: '/v1/responses',
      url: `${await getCodeBuddyApiEndpoint()}/responses`,
    });
    return createErrorResponse(
      500,
      error instanceof Error ? error.message : 'Unexpected upstream error',
    );
  }
};

// Re-exported for the importers that reached these through this module before
// the split: the route handlers, the domain layer, and the test suite.
export type {
  ChatRequestBody,
  DiscoveredModel,
  ProxyContext,
} from './codebuddy-types';
export {
  createProxyContextFromCredential,
  resolveProxyContext,
  resolveProxyContextByCredentialFilename,
} from './codebuddy-context';
export { buildUpstreamHeaders } from './codebuddy-upstream';
export {
  extractImageUrl,
  isImageContentPart,
} from './codebuddy-responses-request';
export {
  getModelsByCredential,
  getModelsForCredential,
  getModelsForCredentials,
  getModelsResponse,
} from './codebuddy-models';
