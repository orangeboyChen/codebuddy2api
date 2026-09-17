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

interface ChatToolCall {
  id?: string;
  function?: { arguments?: string; name?: string };
}

interface ChatCompletionMessage {
  content?: unknown;
  tool_calls?: ChatToolCall[];
}

interface ChatCompletionPayload {
  choices?: Array<{ message?: ChatCompletionMessage }>;
}

/**
 * True when a model tool call targets the rewritten image-generation function.
 * Compared loosely because upstream providers may normalize the name.
 */
export const isImageGenerationToolCall = (toolCall: unknown): boolean => {
  if (!toolCall || typeof toolCall !== 'object') {
    return false;
  }

  const name = (toolCall as ChatToolCall).function?.name;

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
 * Runs image-generation tool calls a chat-protocol model made and returns the
 * final upstream response with the images folded back into the transcript.
 *
 * Returns `null` when the model made no image call, so the caller keeps its
 * ordinary upstream path.
 *
 * The returned response is always freshly constructed: reading an intermediate
 * response to inspect its tool calls consumes the body, and the caller needs to
 * read the final one again.
 */
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
}): Promise<Response | null> => {
  let currentBody: Record<string, unknown> = body;

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
      return response;
    }

    const payloadText = await response.text();
    let payload: ChatCompletionPayload = {};

    try {
      payload = JSON.parse(payloadText) as ChatCompletionPayload;
    } catch {
      // Unparseable upstream output cannot be continued; return it verbatim.
      return new Response(payloadText, {
        headers: response.headers,
        status: response.status,
      });
    }

    const message = payload.choices?.[0]?.message;
    const imageCalls: ChatToolCall[] = (message?.tool_calls ?? []).filter(
      isImageGenerationToolCall,
    );

    if (!imageCalls.length) {
      // Nothing to execute. Rebuild the response so the caller can still read
      // it, since `payloadText` was consumed above.
      return iteration === 0
        ? null
        : new Response(payloadText, {
            headers: response.headers,
            status: response.status,
          });
    }

    const results: unknown[] = [];

    for (const toolCall of imageCalls) {
      const result = await executeImageGeneration({
        arguments: toolCall.function?.arguments ?? '',
        context,
        request,
      });

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
  }

  return null;
};
