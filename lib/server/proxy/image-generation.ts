/**
 * Image generation for the Responses API.
 *
 * Both reference clients disagree here, so this mirrors the one that has a
 * protocol: OpenAI's Responses API exposes `image_generation` as a tool the
 * model invokes, returning an `image_generation_call` output item whose
 * `result` is base64. Anthropic has no equivalent, and CodeBuddy's own CLI
 * calls a separate `/v2/images/generations` endpoint.
 *
 * The two upstream protocols therefore need different handling:
 *
 * - `responses` passthrough forwards the tool declaration untouched, because
 *   CodeBuddy's `/responses` endpoint accepts `image_generation` natively and
 *   streams `image_generation_call` items back.
 * - `chat` has no such concept, so the declaration is rewritten into an
 *   ordinary function and the call is executed here against
 *   `/v2/images/generations`, with the result fed back as a tool message.
 */

import type { NextRequest } from 'next/server';

import { getCodeBuddyApiEndpoint } from '../domain/config';
import type { ProxyContext } from './codebuddy';
import { buildUpstreamHeaders } from './codebuddy';
import {
  withIntermediateTurns,
  type ChatCompletionMessage,
  type ChatCompletionPayload,
  type ChatCompletionToolCall,
} from './web-search-loop';

export const IMAGE_GENERATION_TOOL_TYPE = 'image_generation';

/** Tool name advertised to the chat upstream when rewriting the declaration. */
export const IMAGE_GENERATION_CHAT_TOOL_NAME = 'image_generation';

interface ImageGenerationArguments {
  background?: string;
  input_fidelity?: string;
  model?: string;
  output_compression?: number;
  output_format?: string;
  partial_images?: number;
  prompt?: string;
  quality?: string;
  size?: string;
}

/**
 * The subset of `/v2/images/generations` this proxy sends. Every field is
 * optional upstream; only `prompt` is validated here because a request without
 * it cannot produce an image.
 */
interface ImageGenerationRequest {
  model?: string;
  n?: number;
  prompt: string;
  quality?: string;
  response_format?: 'b64_json';
  size?: string;
}

export interface ImageGenerationResult {
  /** Base64-encoded image bytes, when the upstream returned inline data. */
  b64Json?: string;
  /** Upstream-hosted image URL, when it returned one instead of inline data. */
  url?: string;
}

const asString = (value: unknown): string | undefined => {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

const parseArguments = (raw: string): ImageGenerationArguments => {
  if (!raw.trim()) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(raw);

    return parsed && typeof parsed === 'object'
      ? (parsed as ImageGenerationArguments)
      : {};
  } catch {
    return {};
  }
};

/** The prompt the model asked for, used as the `image_generation_call` label. */
const extractPrompt = (raw: string): string => {
  // Model-generated arguments are untrusted JSON, so a non-string prompt is
  // possible. `executeImageGeneration` already rejects it, and throwing here
  // would turn that handled failure into a 500.
  const { prompt } = parseArguments(raw);

  return typeof prompt === 'string' ? prompt.trim() : '';
};

/**
 * Rewrites an `image_generation` tool declaration as a Chat function so a
 * chat-protocol model can invoke it. The schema is deliberately permissive:
 * the model only needs to supply a prompt, and every optional control is a
 * plain string so a model that ignores them still produces a valid call.
 */
export const buildImageGenerationChatTool = (): {
  description: string;
  name: string;
  parameters: Record<string, unknown>;
} => {
  return {
    description:
      'Generate an image from a text description. Returns a base64-encoded PNG image.',
    name: IMAGE_GENERATION_CHAT_TOOL_NAME,
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Text description of the image to generate.',
        },
        size: {
          type: 'string',
          description:
            'Image dimensions, for example "1024x1024". Optional; the upstream default is used when omitted.',
        },
        quality: {
          type: 'string',
          description:
            'Rendering quality. Optional; the upstream default is used when omitted.',
        },
        background: {
          type: 'string',
          description:
            'Background handling, for example "transparent". Optional.',
        },
        output_format: {
          type: 'string',
          description: 'Output encoding, for example "png". Optional.',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  };
};

const extractFirstImage = (
  payload: unknown,
): ImageGenerationResult | undefined => {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const data = (payload as { data?: unknown }).data;
  const first = Array.isArray(data) ? data[0] : undefined;

  if (!first || typeof first !== 'object') {
    return undefined;
  }

  const image = first as { b64_json?: unknown; url?: unknown };
  const b64Json = asString(image.b64_json);
  const url = asString(image.url);

  if (b64Json) {
    return { b64Json };
  }

  if (url) {
    return { url };
  }

  return undefined;
};

/**
 * Runs one image generation against CodeBuddy's `/v2/images/generations`.
 *
 * Failures resolve to `null` rather than throwing: a broken image tool must not
 * take down the surrounding turn, and the caller reports the failure to the
 * model as a tool result so it can continue.
 */
export const executeImageGeneration = async ({
  arguments: rawArguments,
  context,
  request,
  signal,
}: {
  arguments: string;
  context: ProxyContext;
  request: NextRequest;
  signal?: AbortSignal;
}): Promise<ImageGenerationResult | null> => {
  const args = parseArguments(rawArguments);
  const prompt = asString(args.prompt);

  if (!prompt) {
    return null;
  }

  const body: ImageGenerationRequest = { prompt, response_format: 'b64_json' };
  const model = asString(args.model);
  const size = asString(args.size);
  const quality = asString(args.quality);

  if (model) {
    body.model = model;
  }

  if (size) {
    body.size = size;
  }

  if (quality) {
    body.quality = quality;
  }

  const apiEndpoint = await getCodeBuddyApiEndpoint();
  const headers = await buildUpstreamHeaders(request, context.auth);

  try {
    const response = await fetch(`${apiEndpoint}/v2/images/generations`, {
      body: JSON.stringify(body),
      headers,
      method: 'POST',
      signal,
    });

    if (!response.ok) {
      return null;
    }

    return extractFirstImage(await response.json()) ?? null;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// Chat-protocol execution loop
// ---------------------------------------------------------------------------

/** Bounded because each generation is slow and one round of results suffices. */
const MAX_IMAGE_ITERATIONS = 3;

/**
 * True when a model tool call targets the rewritten image-generation function.
 * Compared loosely because upstream providers may normalize the name.
 */
export const isImageGenerationToolCall = (toolCall: unknown): boolean => {
  if (!toolCall || typeof toolCall !== 'object') {
    return false;
  }

  const name = (toolCall as ChatCompletionToolCall).function?.name;

  return (
    typeof name === 'string' &&
    name.toLowerCase().replaceAll('-', '_') ===
      IMAGE_GENERATION_CHAT_TOOL_NAME.toLowerCase().replaceAll('-', '_')
  );
};

/**
 * Tool result handed back to the model. Inline base64 becomes a data URI so the
 * model can reference the image in later turns; a hosted URL is passed through.
 */
const buildImageToolResult = (result: ImageGenerationResult | null): string => {
  if (result?.b64Json) {
    return `data:image/png;base64,${result.b64Json}`;
  }

  if (result?.url) {
    return result.url;
  }

  return 'Image generation failed: the upstream service returned no image.';
};
/**
 * Runs image-generation tool calls a chat-protocol model makes, replaying the
 * request with each generated image folded back in.
 *
 * Always returns the final upstream response, including when the model made no
 * image call — callers must not re-issue the request themselves, since that
 * would bill the turn twice and could return a different answer from the one
 * already inspected. `executions` is empty when no image was generated.
 *
 * The returned response is always freshly constructed: reading an intermediate
 * response to inspect its tool calls consumes the body, and the caller needs to
 * read the final one again.
 */
export interface ImageGenerationExecution {
  id: string;
  /** The rewritten prompt some providers echo back. Absent when unavailable. */
  prompt: string;
  /**
   * Base64-encoded image, when the upstream returned inline data. This is what
   * an OpenAI `image_generation_call` carries in its `result` field.
   */
  result: string | null;
  status: 'completed' | 'failed';
}

export interface ImageGenerationLoopResult {
  /** One entry per image call the model made, in call order. */
  executions: ImageGenerationExecution[];
  response: Response;
}

/**
 * Rebuilds a response whose body was already read. The loop consumes each
 * response to inspect its tool calls, so anything handed back has to be
 * reconstructed from the text that was read.
 */
const rebuildResponse = (
  response: Response,
  payload: ChatCompletionPayload,
): Response => {
  return new Response(JSON.stringify(payload), {
    headers: response.headers,
    status: response.status,
  });
};

/** Prose a hop wrote, i.e. text the model produced before calling the tool. */
const readMessageText = (
  message: ChatCompletionMessage | undefined,
): string => {
  return typeof message?.content === 'string' ? message.content.trim() : '';
};

const buildImageGenerationExecution = ({
  id,
  prompt,
  result,
}: {
  id: string;
  prompt: string;
  result: ImageGenerationResult | null;
}): ImageGenerationExecution => {
  if (result?.b64Json) {
    return { id, prompt, result: result.b64Json, status: 'completed' };
  }

  return {
    id,
    prompt,
    result: null,
    status: result?.url ? 'completed' : 'failed',
  };
};

export const executeImageGenerationLoop = async ({
  body,
  callUpstream,
  context,
  request,
}: {
  body: Record<string, unknown>;
  callUpstream: (body: Record<string, unknown>) => Promise<Response>;
  context: ProxyContext;
  request: NextRequest;
}): Promise<ImageGenerationLoopResult> => {
  let currentBody: Record<string, unknown> = body;
  const executions: ImageGenerationExecution[] = [];
  const intermediateTexts: string[] = [];
  // Carried across iterations so the cap can hand back the last response
  // instead of discarding every image already generated.
  let lastResponse: Response | null = null;
  let lastPayload: ChatCompletionPayload | null = null;

  for (let iteration = 0; iteration < MAX_IMAGE_ITERATIONS; iteration += 1) {
    const response = await callUpstream(currentBody);

    // A stream has already begun emitting to the client, so it cannot be
    // resumed with a tool result; hand it back untouched.
    if (
      response.headers
        .get('content-type')
        ?.toLowerCase()
        .includes('text/event-stream')
    ) {
      return { executions, response };
    }

    const payloadText = await response.text();
    let payload: ChatCompletionPayload = {};

    try {
      payload = JSON.parse(payloadText) as ChatCompletionPayload;
    } catch {
      // Unparseable upstream output cannot be continued; return it verbatim.
      return {
        executions,
        response: new Response(payloadText, {
          headers: response.headers,
          status: response.status,
        }),
      };
    }

    const message = payload.choices?.[0]?.message;
    const imageCalls: ChatCompletionToolCall[] = (
      message?.tool_calls ?? []
    ).filter(isImageGenerationToolCall);

    if (!imageCalls.length) {
      // Nothing to execute. Hand the response back rather than returning null:
      // the caller must not re-issue the request, since that would bill the
      // turn twice and could yield a different answer. Prose from earlier hops
      // is folded in first, because it is part of the turn the client sees.
      return {
        executions,
        response: rebuildResponse(
          response,
          withIntermediateTurns({
            executions: [],
            payload,
            reasonings: [],
            texts: intermediateTexts,
          }).payload,
        ),
      };
    }

    const iterationText = readMessageText(message);

    if (iterationText) {
      intermediateTexts.push(iterationText);
    }

    const results: unknown[] = [];

    for (const toolCall of imageCalls) {
      const arguments_ = toolCall.function?.arguments ?? '';
      const result = await executeImageGeneration({
        arguments: arguments_,
        context,
        request,
      });

      executions.push(
        buildImageGenerationExecution({
          id: toolCall.id ?? '',
          prompt: extractPrompt(arguments_),
          result,
        }),
      );

      results.push({
        role: 'tool',
        content: buildImageToolResult(result),
        tool_call_id: toolCall.id ?? '',
      });
    }

    const messages: unknown[] = Array.isArray(currentBody.messages)
      ? [...currentBody.messages]
      : [];

    if (message) {
      messages.push(message);
    }

    messages.push(...results);

    currentBody = { ...currentBody, messages };
    lastPayload = payload;
    lastResponse = response;
  }

  // The cap was reached with the model still asking for images. Every image
  // generated so far is kept, and the last response is handed back so the
  // caller does not re-issue the request and discard them.
  return {
    executions,
    response: rebuildResponse(
      lastResponse ?? new Response(null, { status: 502 }),
      withIntermediateTurns({
        executions: [],
        payload: lastPayload ?? {},
        reasonings: [],
        texts: intermediateTexts,
      }).payload,
    ),
  };
};

// ---------------------------------------------------------------------------
// Responses output item
// ---------------------------------------------------------------------------

/**
 * Builds the `image_generation_call` output item OpenAI's Responses API
 * defines, so a client driving the chat upstream still sees the standard shape:
 * the generated image in `result` as base64, and the prompt it came from.
 *
 * `result` is null when generation failed. The field is still emitted, with
 * status `failed`, because dropping it would leave the client with no way to
 * tell that an image was attempted.
 */
export const buildResponsesImageGenerationCallItem = (
  execution: ImageGenerationExecution,
  id = `ig_${crypto.randomUUID().replaceAll('-', '')}`,
): Record<string, unknown> => {
  return {
    id,
    result: execution.result,
    status: execution.status,
    type: 'image_generation_call',
    ...(execution.prompt ? { revised_prompt: execution.prompt } : {}),
  };
};
