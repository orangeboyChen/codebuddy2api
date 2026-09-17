import { asRecord, readReasoning } from '../../shared/content';
import type {
  ChatCompletionMessage,
  ChatCompletionPayload,
  ChatCompletionToolCall,
  JsonRecord,
  ServerToolExecution,
  ServerToolTurn,
} from './types';

export const sumUsage = (accumulated: unknown, incoming: unknown): unknown => {
  const left = asRecord(accumulated);
  const right = asRecord(incoming);

  if (!left) {
    return incoming ?? null;
  }

  if (!right) {
    return accumulated;
  }

  const merged: JsonRecord = { ...left };

  for (const [key, value] of Object.entries(right)) {
    const previous = left[key];

    if (typeof value === 'number' && typeof previous === 'number') {
      merged[key] = previous + value;
    } else if (value !== undefined) {
      merged[key] = value;
    }
  }

  return merged;
};

/**
 * Folds completed search results into the assistant text and re-emits the
 * outstanding tool calls unchanged, so a turn that mixed search with
 * client-side calls stays a valid transcript. The client sees its own calls
 * come back as if upstream had returned them directly.
 *
 * The findings are folded only when the route has no other way to carry them.
 * A route that renders them structurally passes
 * `findingsAsStructuredBlocks`, and the text is left alone: the results are
 * already on the wire as a result block, and a second copy in the prose is
 * what the user reads as the model reciting its own search output.
 */
export const buildMixedTurnPayload = ({
  findingsAsStructuredBlocks = false,
  message,
  payload,
  remainingCalls,
  searchResults,
  usage,
}: {
  findingsAsStructuredBlocks?: boolean;
  message: ChatCompletionMessage | undefined;
  payload: ChatCompletionPayload;
  remainingCalls: ChatCompletionToolCall[];
  searchResults: string[];
  usage?: unknown;
}): ChatCompletionPayload => {
  const existingText =
    typeof message?.content === 'string' && message.content.trim()
      ? message.content.trim()
      : '';
  const findings = findingsAsStructuredBlocks
    ? ''
    : searchResults.filter(Boolean).join('\n\n');
  const content = [existingText, findings].filter(Boolean).join('\n\n');

  return {
    ...payload,
    ...(usage ? { usage } : {}),
    choices: (payload.choices ?? []).map((choice, index) =>
      index === 0
        ? {
            ...choice,
            finish_reason: 'tool_calls',
            message: {
              ...(choice.message ?? {}),
              content: content || null,
              role: 'assistant',
              tool_calls: remainingCalls,
            },
          }
        : choice,
    ),
  };
};

/**
 * Pairs each hop's reasoning and text with the calls that hop made.
 *
 * The three arrays are index-aligned — entry N is hop N — so zipping them back
 * together is what restores the grouping a joined string cannot express. `texts`
 * and `reasonings` are one entry longer than `executions`, because the closing
 * hop answers instead of calling another tool.
 */
export const buildIntermediateTurns = ({
  executions,
  reasonings,
  texts,
}: {
  executions: ServerToolExecution[][];
  reasonings: string[];
  texts: string[];
}): ServerToolTurn[] =>
  Array.from(
    { length: Math.max(reasonings.length, texts.length) },
    (_, index) => ({
      // Only `executions` can run short: the closing hop answers without
      // calling anything, so it has an entry in the prose arrays but none here.
      // The three arrays stay aligned because every hop appends to all of them.
      executions: executions[index] ?? [],
      reasoning: reasonings[index],
      text: texts[index],
    }),
  );

/**
 * Folds the text a multi-hop turn produced before its later server-tool calls
 * into the payload the client receives.
 *
 * Only the last iteration's message is in `payload`, but a turn that searched
 * more than once spoke before each search, and that text is part of the turn:
 * dropping it hides the model's reasoning from the user and leaves the
 * client's transcript out of step with what the model actually said.
 *
 * The same hops are also re-grouped into the `turns` half of the result,
 * because the folded strings cannot express where one hop ends and the next
 * begins. That half travels beside the response rather than inside it: the
 * payload is what an OpenAI-protocol client receives, and `turns` is not part
 * of that protocol, so it is handed over out of band like `executions`.
 *
 * Shared with the image-generation loop, which has the same shape: a local
 * tool call is replayed with its result appended, so only the final hop's
 * message would otherwise survive.
 */
export const withIntermediateTurns = ({
  executions,
  payload,
  reasonings,
  texts,
}: {
  executions: ServerToolExecution[][];
  payload: ChatCompletionPayload;
  reasonings: string[];
  texts: string[];
}): { payload: ChatCompletionPayload; turns: ServerToolTurn[] } => {
  const extraText = texts.filter(Boolean).join('\n\n');
  const extraReasoning = reasonings.filter(Boolean).join('\n\n');
  const [first, ...rest] = payload.choices ?? [];

  if (!first) {
    return { payload, turns: [] };
  }

  const message = first.message ?? {};
  const existingText =
    typeof message.content === 'string' ? message.content : '';

  // Nothing from the earlier hops and nothing to fold in — but the hops may
  // still have run tools, which is exactly the case a caller consuming `turns`
  // needs: a hop that called a tool without speaking first is still a hop.
  if (!extraText && !extraReasoning && !executions.length) {
    return { payload, turns: [] };
  }

  const content = [extraText, existingText].filter(Boolean).join('\n\n');
  const reasoning = [extraReasoning, readReasoning(message)]
    .filter(Boolean)
    .join('\n\n');

  return {
    payload: {
      ...payload,
      choices: [
        {
          ...first,
          message: {
            ...message,
            content,
            ...(reasoning ? { reasoning_content: reasoning } : {}),
          },
        },
        ...rest,
      ],
    },
    // Per-hop grouping for renderers that can express it. The joined strings
    // above stay as the OpenAI-shaped view; a client that builds Anthropic
    // content blocks needs to know where one hop's reasoning ends and the next
    // begins, which a joined string has already lost. The closing hop is the
    // model's final answer, so it carries no further calls.
    turns: buildIntermediateTurns({
      executions,
      reasonings: [...reasonings, readReasoning(message)],
      texts: [...texts, existingText],
    }),
  };
};

export { readReasoning };
