/**
 * Shape assertions for the three protocols this proxy speaks.
 *
 * Each `expect*` helper checks one object against the field set the vendor
 * documents for it — the OpenAI Responses object and its output items, the
 * Anthropic `message` and its content blocks, and the Chat Completions object
 * and its tool calls. They are written out rather than imported from a schema
 * library so a failure names the field that broke, and so the suites for the
 * three routes assert the same reading of "conformant".
 *
 * Only what a client can act on is asserted. Fields a vendor echoes for
 * bookkeeping that this proxy does not own — sampling parameters, for one —
 * are left out on purpose rather than asserted as absent.
 */

export type JsonRecord = Record<string, unknown>;

export const RESPONSE_STATUSES = [
  'completed',
  'failed',
  'in_progress',
  'cancelled',
  'queued',
  'incomplete',
] as const;

export const ITEM_STATUSES = [
  'in_progress',
  'completed',
  'incomplete',
] as const;

export const CHAT_FINISH_REASONS = [
  'stop',
  'length',
  'tool_calls',
  'content_filter',
  'function_call',
] as const;

/**
 * Anthropic's `StopReason`. `pause_turn`, `refusal` and
 * `model_context_window_exceeded` are legal too, but this proxy never stops
 * for them.
 */
export const ANTHROPIC_STOP_REASONS = [
  'end_turn',
  'max_tokens',
  'stop_sequence',
  'tool_use',
] as const;

export const ANTHROPIC_BLOCK_DELTA_TYPES = [
  'text_delta',
  'thinking_delta',
  'input_json_delta',
  'signature_delta',
] as const;

/** One `event:` / `data:` pair from an SSE body. */
export interface SseFrame {
  data: string;
  event: string;
}

export const parseSseFrames = (body: string): SseFrame[] => {
  const frames: SseFrame[] = [];
  let event = 'message';
  let data = '';

  const flush = (): void => {
    if (data) {
      frames.push({ data, event });
    }

    event = 'message';
    data = '';
  };

  for (const line of body.split('\n')) {
    if (line === '') {
      flush();
      continue;
    }

    if (line.startsWith('event: ')) {
      event = line.slice(7).trim();
      continue;
    }

    if (line.startsWith('data: ')) {
      data = `${data}${data ? '\n' : ''}${line.slice(6).trim()}`;
    }
  }

  flush();

  return frames;
};

/** The decoded payloads, in wire order. `[DONE]` is dropped. */
export const readSseEvents = (body: string): JsonRecord[] =>
  parseSseFrames(body)
    .filter(({ data }) => data !== '[DONE]')
    .map(({ data }) => JSON.parse(data) as JsonRecord);

const isPlainObject = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const expectNonEmptyString = (value: unknown, label: string): void => {
  expect(typeof value, `${label} must be a string`).toBe('string');
  expect(String(value).length > 0, `${label} must not be empty`).toBe(true);
};

const expectInteger = (value: unknown, label: string): void => {
  expect(typeof value, `${label} must be a number`).toBe('number');
  expect(Number.isFinite(value as number), `${label} must be finite`).toBe(
    true,
  );
};

const expectOneOf = (
  value: unknown,
  allowed: readonly string[],
  label: string,
): void => {
  expect(
    allowed.includes(String(value)),
    `${label} must be one of ${allowed.join(', ')} but was ${String(value)}`,
  ).toBe(true);
};

// ---------------------------------------------------------------------------
// OpenAI Responses
// ---------------------------------------------------------------------------

/**
 * The `usage` object. The details objects are required wholesale — a client
 * that reads `input_tokens_details.cached_tokens` for its cost accounting
 * gets `undefined` if the breakdown is dropped.
 */
export const expectResponsesUsage = (value: unknown): void => {
  expect(isPlainObject(value), 'usage must be an object').toBe(true);
  const usage = value as JsonRecord;

  expectInteger(usage.input_tokens, 'usage.input_tokens');
  expectInteger(usage.output_tokens, 'usage.output_tokens');
  expectInteger(usage.total_tokens, 'usage.total_tokens');

  expect(isPlainObject(usage.input_tokens_details)).toBe(true);
  const inputDetails = usage.input_tokens_details as JsonRecord;
  expectInteger(
    inputDetails.cached_tokens,
    'usage.input_tokens_details.cached_tokens',
  );
  expectInteger(
    inputDetails.cache_write_tokens,
    'usage.input_tokens_details.cache_write_tokens',
  );

  expect(isPlainObject(usage.output_tokens_details)).toBe(true);
  expectInteger(
    (usage.output_tokens_details as JsonRecord).reasoning_tokens,
    'usage.output_tokens_details.reasoning_tokens',
  );
};

/** One item of `output`, whatever kind it is. */
export const expectResponsesOutputItem = (value: unknown): void => {
  expect(isPlainObject(value), 'an output item must be an object').toBe(true);
  const item = value as JsonRecord;
  expectNonEmptyString(item.id, 'output item id');
  expectNonEmptyString(item.type, 'output item type');

  switch (item.type) {
    case 'message': {
      expect(item.role, 'a message item is written by the assistant').toBe(
        'assistant',
      );
      expectOneOf(item.status, ITEM_STATUSES, 'message status');
      expect(
        Array.isArray(item.content),
        'message content must be an array',
      ).toBe(true);

      (item.content as unknown[]).forEach((part) => {
        expect(isPlainObject(part), 'a content part must be an object').toBe(
          true,
        );
        const content = part as JsonRecord;
        expect(
          content.type,
          'output_text is the only content part emitted',
        ).toBe('output_text');
        expect(typeof content.text, 'output_text.text must be a string').toBe(
          'string',
        );
        expect(
          Array.isArray(content.annotations),
          'output_text.annotations must be an array',
        ).toBe(true);

        (content.annotations as unknown[]).forEach((annotation) => {
          const citation = annotation as JsonRecord;
          expect(citation.type, 'an annotation is a url_citation').toBe(
            'url_citation',
          );
          expectNonEmptyString(citation.url, 'url_citation.url');
          expectNonEmptyString(citation.title, 'url_citation.title');
          const start = citation.start_index as number;
          const end = citation.end_index as number;
          expectInteger(start, 'url_citation.start_index');
          expectInteger(end, 'url_citation.end_index');
          expect(
            start >= 0 && end > start && end <= String(content.text).length,
            'a citation must point inside the text it annotates',
          ).toBe(true);
        });
      });
      break;
    }

    case 'function_call': {
      // `call_id` is what the client sends back as `function_call_output`, so
      // it is the one field here that has to survive the round trip intact.
      expectNonEmptyString(item.call_id, 'function_call.call_id');
      expectNonEmptyString(item.name, 'function_call.name');
      expectOneOf(item.status, ITEM_STATUSES, 'function_call status');
      expect(
        typeof item.arguments,
        'function_call.arguments must be a JSON string',
      ).toBe('string');
      expect(
        () => JSON.parse(String(item.arguments)),
        'function_call.arguments must parse as JSON',
      ).not.toThrow();
      break;
    }

    case 'mcp_call': {
      expectNonEmptyString(item.server_label, 'mcp_call.server_label');
      expectNonEmptyString(item.name, 'mcp_call.name');
      expect(typeof item.arguments, 'mcp_call.arguments must be a string').toBe(
        'string',
      );
      expect(() => JSON.parse(String(item.arguments))).not.toThrow();
      break;
    }

    case 'web_search_call': {
      expectOneOf(item.status, ITEM_STATUSES, 'web_search_call status');
      expect(
        isPlainObject(item.action),
        'web_search_call.action is required',
      ).toBe(true);
      const action = item.action as JsonRecord;
      expectOneOf(
        action.type,
        ['search', 'open_page', 'find_in_page'],
        'web_search_call action type',
      );

      if (action.type === 'search') {
        expectNonEmptyString(action.query, 'a search action needs a query');
      } else {
        expectNonEmptyString(action.url, 'a page action needs a url');
      }
      break;
    }

    case 'reasoning': {
      expect(
        Array.isArray(item.summary),
        'reasoning.summary must be an array',
      ).toBe(true);
      (item.summary as unknown[]).forEach((part) => {
        expect((part as JsonRecord).type).toBe('summary_text');
        expect(typeof (part as JsonRecord).text).toBe('string');
      });
      expectOneOf(item.status, ITEM_STATUSES, 'reasoning status');
      break;
    }

    default:
      expect(
        item.type,
        `unexpected output item type ${String(item.type)}`,
      ).toBe('message');
  }
};

/**
 * The response object itself. `output_text` and `output` are what a client
 * reads; the echoed request fields are checked because the spec marks them
 * required and a client may read `tool_choice` or `error` off the object.
 */
export const expectResponsesObject = (value: unknown): void => {
  expect(isPlainObject(value), 'the response must be an object').toBe(true);
  const payload = value as JsonRecord;

  expect(payload.id, 'a response id is prefixed resp_').toMatch(/^resp_/);
  expect(payload.object).toBe('response');
  expectInteger(payload.created_at, 'created_at');
  expectOneOf(payload.status, RESPONSE_STATUSES, 'response status');
  expectNonEmptyString(payload.model, 'response model');
  expect(Array.isArray(payload.output), 'output must be an array').toBe(true);
  (payload.output as unknown[]).forEach(expectResponsesOutputItem);
  // An in-progress announcement has no text to aggregate yet; a completed one
  // always does, even when the model answered with a tool call and the text is
  // empty.
  expect(
    payload.status !== 'completed' || typeof payload.output_text === 'string',
    'a completed response must carry output_text',
  ).toBe(true);
  // Same reasoning as `output_text`: an announcement mid-turn has nothing to
  // bill yet, while a completed response is always charged for and a client
  // reading the counters off it must find them.
  if (payload.status === 'completed' || payload.usage !== undefined) {
    expectResponsesUsage(payload.usage);
  }

  // Echoed, not generated: the request's own settings, so a client continuing
  // the turn can read them back off the object it was handed.
  expect(Array.isArray(payload.tools), 'tools must be an array').toBe(true);
  expect(payload.tool_choice, 'tool_choice must be present').toBeDefined();
  expect(
    payload.parallel_tool_calls,
    'parallel_tool_calls must be present',
  ).toBeDefined();
  expect(isPlainObject(payload.metadata), 'metadata must be an object').toBe(
    true,
  );
  expect(
    payload.instructions === null || typeof payload.instructions === 'string',
    'instructions must be null or a string',
  ).toBe(true);
  expect(
    payload.error === null || isPlainObject(payload.error),
    'error must be null or an object',
  ).toBe(true);
  expect(
    payload.incomplete_details === null ||
      isPlainObject(payload.incomplete_details),
    'incomplete_details must be null or an object',
  ).toBe(true);
};

// ---------------------------------------------------------------------------
// Anthropic Messages
// ---------------------------------------------------------------------------

export const expectAnthropicUsage = (value: unknown): void => {
  expect(isPlainObject(value), 'usage must be an object').toBe(true);
  const usage = value as JsonRecord;

  expectInteger(usage.input_tokens, 'usage.input_tokens');
  expectInteger(usage.output_tokens, 'usage.output_tokens');

  if (usage.server_tool_use !== undefined) {
    const serverToolUse = usage.server_tool_use as JsonRecord;
    expectInteger(
      serverToolUse.web_search_requests,
      'usage.server_tool_use.web_search_requests',
    );
  }
};

/** One block of a `message` `content` array. */
export const expectAnthropicContentBlock = (value: unknown): void => {
  expect(isPlainObject(value), 'a content block must be an object').toBe(true);
  const block = value as JsonRecord;

  switch (block.type) {
    case 'text':
      expect(typeof block.text, 'text.text must be a string').toBe('string');
      break;

    case 'thinking':
      expect(typeof block.thinking, 'thinking.thinking must be a string').toBe(
        'string',
      );
      break;

    case 'tool_use':
      expectNonEmptyString(block.id, 'tool_use.id');
      expectNonEmptyString(block.name, 'tool_use.name');
      expect(
        isPlainObject(block.input),
        'tool_use.input must be an object',
      ).toBe(true);
      break;

    case 'server_tool_use':
      // The pattern Anthropic documents for these ids: a client keys its
      // `tool_result` off it, and an id of another shape is rejected.
      expect(block.id, 'server_tool_use ids are prefixed srvtoolu_').toMatch(
        /^srvtoolu_[A-Za-z0-9_]+$/,
      );
      expectOneOf(
        block.name,
        ['web_search', 'web_fetch', 'code_execution'],
        'server_tool_use name',
      );
      expect(isPlainObject(block.input), 'server_tool_use.input').toBe(true);
      break;

    case 'web_search_tool_result':
      expect(block.tool_use_id).toMatch(/^srvtoolu_[A-Za-z0-9_]+$/);
      expect(
        Array.isArray(block.content),
        'a search result carries a list of results',
      ).toBe(true);
      (block.content as unknown[]).forEach((entry) => {
        const result = entry as JsonRecord;
        expect(result.type).toBe('web_search_result');
        expectNonEmptyString(result.url, 'web_search_result.url');
        expectNonEmptyString(result.title, 'web_search_result.title');
        expectNonEmptyString(
          result.encrypted_content,
          'web_search_result.encrypted_content',
        );
      });
      break;

    case 'web_fetch_tool_result':
      expect(block.tool_use_id).toMatch(/^srvtoolu_[A-Za-z0-9_]+$/);
      const fetched = block.content as JsonRecord;
      expect(fetched.type).toBe('web_fetch_result');
      expectNonEmptyString(fetched.url, 'web_fetch_result.url');
      const document = fetched.content as JsonRecord;
      expect(document.type).toBe('document');
      const source = document.source as JsonRecord;
      expect(source.type).toBe('text');
      expectNonEmptyString(source.data, 'web_fetch_result document data');
      break;

    default:
      expect(block.type, `unexpected content block ${String(block.type)}`).toBe(
        'text',
      );
  }
};

export const expectAnthropicMessage = (value: unknown): void => {
  expect(isPlainObject(value), 'the message must be an object').toBe(true);
  const message = value as JsonRecord;

  expect(message.type).toBe('message');
  expect(message.role).toBe('assistant');
  expectNonEmptyString(message.id, 'message id');
  expectNonEmptyString(message.model, 'message model');
  expectOneOf(message.stop_reason, ANTHROPIC_STOP_REASONS, 'stop_reason');
  expect(
    message.stop_sequence === null || typeof message.stop_sequence === 'string',
    'stop_sequence must be null or a string',
  ).toBe(true);
  expect(Array.isArray(message.content), 'content must be an array').toBe(true);
  (message.content as unknown[]).forEach(expectAnthropicContentBlock);
  expectAnthropicUsage(message.usage);
};

/**
 * The event sequence of an Anthropic stream.
 *
 * The grammar is what makes the stream replayable: every `content_block_start`
 * needs a `content_block_stop` at the same index, indices run without gaps,
 * and the turn ends with `message_delta` carrying the stop reason and
 * `message_stop` closing it.
 */
export const expectAnthropicEventSequence = (events: JsonRecord[]): void => {
  expect(events.length > 0, 'the stream must carry events').toBe(true);
  expect(events[0].type).toBe('message_start');
  expect(events.at(-1)?.type).toBe('message_stop');

  const opened = new Set<number>();
  const closed = new Set<number>();
  let nextIndex = 0;

  events.forEach((event) => {
    switch (event.type) {
      case 'message_start': {
        const message = event.message as JsonRecord;
        expect(message.type).toBe('message');
        expect(message.role).toBe('assistant');
        expect(message.stop_reason, 'nothing has stopped yet').toBeNull();
        expect(Array.isArray(message.content)).toBe(true);
        expectAnthropicUsage(message.usage);
        break;
      }

      case 'content_block_start': {
        const index = event.index as number;
        expect(index, 'block indices must not skip').toBe(nextIndex);
        nextIndex += 1;
        opened.add(index);
        expectAnthropicContentBlock(event.content_block);
        break;
      }

      case 'content_block_delta': {
        const index = event.index as number;
        expect(opened.has(index), 'a delta belongs to an open block').toBe(
          true,
        );
        const delta = event.delta as JsonRecord;
        expectOneOf(delta.type, ANTHROPIC_BLOCK_DELTA_TYPES, 'delta type');
        break;
      }

      case 'content_block_stop': {
        const index = event.index as number;
        expect(opened.has(index), 'only an open block can be closed').toBe(
          true,
        );
        closed.add(index);
        break;
      }

      case 'message_delta': {
        const delta = event.delta as JsonRecord;
        expectOneOf(delta.stop_reason, ANTHROPIC_STOP_REASONS, 'stop_reason');
        expectAnthropicUsage(event.usage);
        break;
      }

      case 'message_stop':
        break;

      default:
        expect(event.type, `unexpected event ${String(event.type)}`).toBe(
          'message_stop',
        );
    }
  });

  expect(
    [...opened].every((index) => closed.has(index)),
    'every opened block must be closed',
  ).toBe(true);
};

// ---------------------------------------------------------------------------
// OpenAI Chat Completions
// ---------------------------------------------------------------------------

/** One entry of `message.tool_calls`, as the chat protocol spells it. */
export const expectChatToolCall = (value: unknown): void => {
  expect(isPlainObject(value), 'a tool call must be an object').toBe(true);
  const toolCall = value as JsonRecord;

  expectNonEmptyString(toolCall.id, 'tool call id');
  expect(toolCall.type).toBe('function');
  expect(isPlainObject(toolCall.function), 'tool call function').toBe(true);
  const fn = toolCall.function as JsonRecord;
  expectNonEmptyString(fn.name, 'tool call function name');
  expect(typeof fn.arguments, 'tool call arguments must be a string').toBe(
    'string',
  );
  expect(
    () => JSON.parse(String(fn.arguments)),
    'tool call arguments must parse as JSON',
  ).not.toThrow();
};

export const expectChatCompletion = (value: unknown): void => {
  expect(isPlainObject(value), 'the completion must be an object').toBe(true);
  const payload = value as JsonRecord;

  expect(payload.object).toBe('chat.completion');
  expectNonEmptyString(payload.id, 'completion id');
  expectNonEmptyString(payload.model, 'completion model');
  expectInteger(payload.created, 'created');
  expect(Array.isArray(payload.choices), 'choices must be an array').toBe(true);
  expect((payload.choices as unknown[]).length > 0).toBe(true);

  (payload.choices as unknown[]).forEach((entry) => {
    const choice = entry as JsonRecord;
    expectInteger(choice.index, 'choice index');
    expectOneOf(choice.finish_reason, CHAT_FINISH_REASONS, 'finish_reason');
    const message = choice.message as JsonRecord;
    expect(message.role).toBe('assistant');
    expect(
      message.content === null || typeof message.content === 'string',
      'message content must be null or a string',
    ).toBe(true);

    if (message.tool_calls !== undefined) {
      expect(Array.isArray(message.tool_calls)).toBe(true);
      (message.tool_calls as unknown[]).forEach(expectChatToolCall);
    }
  });
};
