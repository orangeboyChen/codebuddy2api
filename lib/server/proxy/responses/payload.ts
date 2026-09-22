// ---------------------------------------------------------------------------
// Non-streaming Responses payload assembly
// ---------------------------------------------------------------------------

import { stringifyContent } from '../../shared/content';
import {
  createSseResponse,
  DONE_FRAME_TEXT,
  eventFrameText,
} from '../../shared/sse';
import type { ProxyContext } from '../codebuddy';
import type { WebSearchResult } from '../../search/types';
import {
  buildResponsesImageGenerationCallItem,
  type ImageGenerationExecution,
} from '../image-generation';
import {
  createMessageId,
  createResponseId,
  createResponseOutputId,
  createResponseReasoningId,
  normalizeToolCallId,
} from './ids';
import { storeResponseSession } from './session';
import { buildResponsesToolCallOutputItem } from './tools';
import {
  buildAssistantTranscriptToolCalls,
  getAssistantTranscriptContent,
  mapChatUsageToResponses,
  REASONING_PREFIX,
} from './transcript';
import type {
  ChatResponseMessage,
  ResponseSessionDefaults,
  TranscriptMessage,
} from './types';
import type {
  ServerToolExecution,
  ServerToolInvocation,
  ServerToolSegment,
} from '../server-tools';

/** A span of `output_text` that points at one search result. */
interface UrlCitationSpan {
  end: number;
  start: number;
  title: string;
  url: string;
}

/**
 * The `url_citation` annotations for one `output_text`.
 *
 * Only URLs the model actually wrote into the text are annotated, because no
 * index here can be derived: a search response carries titles and URLs but no
 * offsets into an answer that does not exist yet, and the upstream chat
 * protocol hands the answer back as a single opaque string — so choosing a
 * span for a result would mean inventing one. A model that cites a source
 * normally quotes its URL, and that occurrence is a span measured rather than
 * guessed. A result whose URL never appears in the text gets no annotation.
 */
const buildUrlCitationAnnotations = (
  text: string,
  results: WebSearchResult[],
): Array<Record<string, unknown>> => {
  const claimed = new Set<string>();

  const spans = results.flatMap((result): UrlCitationSpan[] => {
    const url = result.url ?? '';

    // Two results can share a URL; a second span over identical offsets would
    // overlap the first by definition.
    if (!url || claimed.has(url)) {
      return [];
    }

    claimed.add(url);
    const title = result.title || url;
    const found: UrlCitationSpan[] = [];

    for (
      let start = text.indexOf(url);
      start !== -1;
      start = text.indexOf(url, start + url.length)
    ) {
      found.push({ end: start + url.length, start, title, url });
    }

    return found;
  });

  // Longest first at one offset: a result URL that prefixes another would
  // otherwise take the shorter span and leave the longer one overlapping.
  spans.sort((left, right) => left.start - right.start || right.end - left.end);

  const annotations: Array<Record<string, unknown>> = [];
  let coveredUntil = 0;

  spans.forEach(({ end, start, title, url }) => {
    if (start < coveredUntil) {
      return;
    }

    coveredUntil = end;
    annotations.push({
      type: 'url_citation',
      start_index: start,
      end_index: end,
      title,
      url,
    });
  });

  return annotations;
};

/**
 * The Response fields that echo the request instead of describing output.
 *
 * The Responses API marks every one of them required on the response object,
 * so a client that reads `tool_choice` or `instructions` off what it was
 * handed — or that checks `error` before reading `output` — finds `undefined`
 * when they are left out.
 *
 * `temperature` and `top_p` are deliberately absent: the proxy never samples,
 * so any number it put there would be invented, and a client that echoed the
 * value back on the next turn would be asking for sampling this deployment
 * does not do.
 */
export const buildResponsesRequestEcho = (
  defaults: ResponseSessionDefaults,
): Record<string, unknown> => ({
  error: null,
  incomplete_details: null,
  instructions: defaults.instructions ?? null,
  parallel_tool_calls: true,
  tool_choice: defaults.tool_choice ?? 'auto',
  tools: defaults.tools ?? [],
});

export const mapChatResponseToResponsesPayload = async (
  accessKeyId: string | null,
  credentialFilename: string | null,
  defaults: ResponseSessionDefaults,
  transcript: TranscriptMessage[],
  model: string,
  previousResponseId: string | null,
  upstreamPayload: Record<string, unknown>,
  serverToolExecutions: ServerToolExecution[],
  imageExecutions: ImageGenerationExecution[] = [],
  pinnedResponseId?: string,
  segments?: ServerToolSegment[],
): Promise<Record<string, unknown>> => {
  const responseId = pinnedResponseId ?? createResponseId();
  const choices = Array.isArray(upstreamPayload.choices)
    ? upstreamPayload.choices
    : [];
  const firstChoice = (choices[0] ?? {}) as {
    message?: ChatResponseMessage;
  };
  const toolCalls = Array.isArray(firstChoice.message?.tool_calls)
    ? firstChoice.message.tool_calls
    : [];
  const outputText = stringifyContent(firstChoice.message?.content);
  const createdAt = Math.floor(Date.now() / 1000);
  // What the model said before it reached for a search, ahead of the searches
  // themselves — the order it was written in. Only the closing hop's prose and
  // reasoning live in `upstreamPayload`, so without this a Responses client
  // never sees the first half of the turn.
  // Interleaved, matching the Anthropic renderer: each hop's prose, then the
  // calls it asked for. A single leading preamble would put prose written
  // between two searches before both of them.
  const segmentItems: Array<Record<string, unknown>> = segments
    ? segments.flatMap((segment) => [
        ...(segment.reasoning
          ? [
              {
                id: createResponseReasoningId(),
                type: 'reasoning',
                summary: [{ type: 'summary_text', text: segment.reasoning }],
                encrypted_content: `${REASONING_PREFIX}${segment.reasoning}`,
                status: 'completed',
              },
            ]
          : []),
        ...(segment.text
          ? [
              {
                id: createMessageId(),
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [
                  { type: 'output_text', text: segment.text, annotations: [] },
                ],
              },
            ]
          : []),
        ...segment.executions.map((execution) =>
          buildResponsesWebSearchCallItem(execution, 'completed'),
        ),
      ])
    : [];

  const output: Array<Record<string, unknown>> = [
    ...segmentItems,
    ...(segments
      ? []
      : serverToolExecutions.map((execution) =>
          buildResponsesWebSearchCallItem(execution, 'completed'),
        )),
    // Image generation is executed locally, so the standard
    // `image_generation_call` item has to be synthesized here — the chat
    // upstream has no notion of it.
    ...imageExecutions.map((execution) =>
      buildResponsesImageGenerationCallItem(execution),
    ),
  ];
  const transcriptToolCalls = buildAssistantTranscriptToolCalls(
    toolCalls,
    defaults.tools,
  );

  // Emit the reasoning as its own item, ahead of the message it produced.
  //
  // Clients replay `output` verbatim on the next turn, so this is what lets a
  // stateless Responses client carry reasoning forward. Without it the only
  // reasoning we ever hand back is a transient `reasoning_text.delta`, which no
  // client can replay because it has no id and no blob to send back.
  //
  // `encrypted_content` holds the reasoning verbatim, not ciphertext. Codex
  // never opens it — it only echoes it — so plaintext round-trips exactly as
  // well, and encrypting would obscure a value that carries no secret: the
  // upstream gave us a summary, and the `summary` field below already shows it.
  const reasoningText =
    firstChoice.message?.reasoning_content ??
    firstChoice.message?.reasoning ??
    '';

  if (reasoningText) {
    output.push({
      id: createResponseReasoningId(),
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: reasoningText }],
      encrypted_content: `${REASONING_PREFIX}${reasoningText}`,
      status: 'completed',
    });
  }

  // Exactly the searches this response reports. Only those may be cited: a
  // result the client saw no `web_search_call` for is not a source it can
  // trace the citation back to.
  const reportedExecutions = segments
    ? segments.flatMap((segment) => segment.executions)
    : serverToolExecutions;

  const citedResults = reportedExecutions.flatMap((execution) =>
    execution.type === 'web_search' ? (execution.result?.results ?? []) : [],
  );

  if (outputText || !toolCalls.length) {
    output.push({
      id: createMessageId(),
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [
        {
          type: 'output_text',
          text: outputText,
          annotations: buildUrlCitationAnnotations(outputText, citedResults),
        },
      ],
    });
  }

  toolCalls.forEach((toolCall, index) => {
    output.push(
      buildResponsesToolCallOutputItem(defaults.tools, {
        arguments: toolCall.function?.arguments ?? '',
        callId: normalizeToolCallId(toolCall.id, index),
        id: createResponseOutputId(),
        name: toolCall.function?.name ?? 'function',
        status: 'completed',
      }),
    );
  });

  await storeResponseSession({
    accessKeyId,
    credentialFilename,
    createdAt: Date.now(),
    id: responseId,
    model,
    transcript: [
      ...transcript,
      {
        role: 'assistant',
        content: getAssistantTranscriptContent(outputText, transcriptToolCalls),
        ...(transcriptToolCalls ? { tool_calls: transcriptToolCalls } : {}),
        // A client that continues via `previous_response_id` rather than
        // replaying `output` never sees the reasoning item, so the session is
        // the only place the reasoning can survive into the next turn.
        ...(reasoningText ? { reasoning: reasoningText } : {}),
      },
    ],
    defaults,
    upstreamProtocol: 'chat',
  });

  return {
    id: responseId,
    object: 'response',
    created_at: createdAt,
    completed_at: createdAt,
    status: 'completed',
    model,
    output,
    output_text: outputText,
    usage: mapChatUsageToResponses(upstreamPayload.usage),
    metadata: defaults.metadata ?? {},
    previous_response_id: previousResponseId,
    ...buildResponsesRequestEcho(defaults),
  };
};

export const buildResponsesWebSearchCallItem = (
  execution: ServerToolExecution | ServerToolInvocation,
  status: 'completed' | 'in_progress',
  id = `ws_${crypto.randomUUID().replaceAll('-', '')}`,
): Record<string, unknown> => ({
  id,
  type: 'web_search_call',
  status,
  action:
    execution.type === 'web_search'
      ? { type: 'search', query: execution.input.query }
      : {
          type: 'open_page',
          url:
            'result' in execution
              ? (execution.result.url ?? execution.input.url)
              : execution.input.url,
        },
});

/**
 * Emits an already-buffered chat payload as a Responses SSE stream.
 *
 * Used when a request had to be buffered to inspect it — image generation is
 * executed locally, so the call cannot be forwarded before it is seen. The
 * client still asked for `stream: true`, so the buffered result is replayed as
 * the same event sequence a live stream would have produced.
 *
 * The text is replayed as delta events rather than arriving whole in
 * `response.completed`: a client that renders as it reads subscribes to deltas
 * and would otherwise show nothing until the turn ends.
 */
export const mapChatResponseToResponsesStream = async (
  upstreamPayload: Record<string, unknown>,
  defaults: ResponseSessionDefaults,
  transcript: TranscriptMessage[],
  model: string,
  previousResponseId: string | null,
  proxyContext: ProxyContext,
  imageExecutions: ImageGenerationExecution[],
  serverToolExecutions: ServerToolExecution[] = [],
  pinnedResponseId?: string,
  segments?: ServerToolSegment[],
  emitOpeningEvents = true,
): Promise<Response> => {
  const payload = await mapChatResponseToResponsesPayload(
    proxyContext.accessKeyId,
    proxyContext.credentialFilename,
    defaults,
    transcript,
    model,
    previousResponseId,
    upstreamPayload,
    serverToolExecutions,
    imageExecutions,
    pinnedResponseId,
    segments,
  );
  // The mapper creates and persists the session id, so the stream has to reuse
  // it: advertising a different one would leave a client unable to continue the
  // turn, because nothing was stored under the id it was given.
  const responseId = String(payload.id);
  const output = payload.output as Array<Record<string, unknown>>;
  // The last message, not the first: a segment's prose is a message too, and
  // streaming the pre-search prose as the answer would drop the real one.
  let messageIndex = -1;
  output.forEach((item, index) => {
    if (item.type === 'message') {
      messageIndex = index;
    }
  });
  const messageItem =
    messageIndex === -1
      ? null
      : (output[messageIndex] as {
          content?: Array<{ text?: string }>;
          id?: string;
        });
  const messageText = messageItem?.content?.[0]?.text ?? '';
  const otherItems = output
    .map((item, output_index) => ({ item, output_index }))
    .filter(({ output_index }) => output_index !== messageIndex);

  // The live path announces a server-tool item as in-progress and narrates its
  // lifecycle before closing it, and consumers can subscribe to those events.
  // A buffered replay that jumps straight to `done` hides the search entirely
  // from a client watching for it.
  const serverToolFrames = ({
    item,
    output_index,
  }: {
    item: Record<string, unknown>;
    output_index: number;
  }): Array<Record<string, unknown>> => {
    const itemId = String(item.id ?? '');

    if (item.type !== 'web_search_call') {
      return [
        {
          item,
          output_index,
          response_id: responseId,
          type: 'response.output_item.added',
        },
      ];
    }

    return [
      {
        item: { ...item, status: 'in_progress' },
        output_index,
        response_id: responseId,
        type: 'response.output_item.added',
      },
      {
        item_id: itemId,
        output_index,
        type: 'response.web_search_call.in_progress',
      },
      {
        item_id: itemId,
        output_index,
        type: 'response.web_search_call.searching',
      },
      {
        item_id: itemId,
        output_index,
        type: 'response.web_search_call.completed',
      },
    ];
  };

  const frames: Array<Record<string, unknown>> = [
    // Skipped when the caller already announced the opening: a streaming
    // server-tool turn emits it up front so the connection is not idle for
    // the whole turn, and a second copy would give the client two ids.
    ...(emitOpeningEvents
      ? [
          {
            response: {
              ...payload,
              // `completed_at` is only set once the response is completed, and
              // this frame is the announcement that it is not.
              completed_at: null,
              output: [],
              status: 'in_progress',
            },
            type: 'response.created',
          },
          {
            response: { id: responseId, status: 'in_progress' },
            type: 'response.in_progress',
          },
        ]
      : []),
    ...otherItems.flatMap(({ item, output_index }) =>
      serverToolFrames({ item, output_index }),
    ),
    ...otherItems.map(({ item, output_index }) => ({
      item,
      output_index,
      response_id: responseId,
      type: 'response.output_item.done',
    })),
  ];

  // Mirrors the live path: the message item is announced, filled by deltas,
  // then closed. No `content_part` events — the live path does not emit them.
  if (messageItem && messageIndex !== -1) {
    frames.push({
      item: { ...messageItem, status: 'in_progress' },
      output_index: messageIndex,
      response_id: responseId,
      type: 'response.output_item.added',
    });

    if (messageText) {
      frames.push({
        delta: messageText,
        item_id: messageItem.id,
        output_index: messageIndex,
        response_id: responseId,
        type: 'response.output_text.delta',
      });
      frames.push({
        item: messageItem,
        output_index: messageIndex,
        response_id: responseId,
        text: messageText,
        type: 'response.output_text.done',
      });
    }

    frames.push({
      item: messageItem,
      output_index: messageIndex,
      response_id: responseId,
      type: 'response.output_item.done',
    });
  }

  frames.push({
    response: { ...payload, id: responseId },
    type: 'response.completed',
  });

  const body = [
    ...frames.map((frame) => eventFrameText(String(frame.type), frame)),
    DONE_FRAME_TEXT,
    '',
  ].join('\n\n');

  return createSseResponse(body);
};
