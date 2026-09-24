import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/server/domain/config', () => ({
  getCodeBuddyApiEndpoint: async () => 'https://upstream.test',
  getDefaultModel: async () => 'glm-5.1',
}));

const { normalizeMessages } =
  await import('@/lib/server/proxy/codebuddy/upstream');

type Message = Parameters<typeof normalizeMessages>[0][number];

const toolCalls = [
  {
    id: 'call_00_B9WLF7niVU1uNuMY5VQi9647',
    type: 'function',
    function: { name: 'report_bug', arguments: '{}' },
  },
];

const assistantToolCall = (extra: Record<string, unknown> = {}): Message =>
  ({ role: 'assistant', tool_calls: toolCalls, ...extra }) as Message;

const toolResult = (): Message =>
  ({
    role: 'tool',
    tool_call_id: 'call_00_B9WLF7niVU1uNuMY5VQi9647',
    content: 'found 3 issues',
  }) as Message;

const roles = (messages: Message[]): string[] =>
  messages.map((message) => String(message.role));

/**
 * Dropping the assistant turn that declared a tool call leaves its result
 * orphaned, and the upstream rejects the pair-less history.
 */
describe('normalizeMessages tool turns', () => {
  it('keeps an assistant tool call that carries no content', () => {
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'review this' },
      assistantToolCall(),
      toolResult(),
    ] as Message[];

    const normalized = normalizeMessages(messages, false, false);

    expect(roles(normalized)).toEqual(['system', 'user', 'assistant', 'tool']);
  });

  it('keeps the tool-call and tool-result pair together', () => {
    const messages = [
      { role: 'user', content: 'review this' },
      assistantToolCall(),
      toolResult(),
    ] as Message[];

    const normalized = normalizeMessages(messages, false, false);
    const assistant = normalized.find(
      (message) => message.role === 'assistant',
    );
    const result = normalized.find((message) => message.role === 'tool');

    expect(assistant?.tool_calls).toEqual(toolCalls);
    expect(result?.tool_call_id).toBe('call_00_B9WLF7niVU1uNuMY5VQi9647');
  });

  it('keeps an assistant tool call whose content is null', () => {
    const messages = [
      { role: 'user', content: 'review this' },
      assistantToolCall({ content: null }),
      toolResult(),
    ] as Message[];

    expect(roles(normalizeMessages(messages, false, false))).toEqual([
      'user',
      'assistant',
      'tool',
    ]);
  });

  it('keeps several consecutive tool rounds', () => {
    const messages = [
      { role: 'user', content: 'review this' },
      assistantToolCall(),
      toolResult(),
      assistantToolCall(),
      toolResult(),
    ] as Message[];

    const normalized = normalizeMessages(messages, false, false);

    expect(normalized).toHaveLength(5);
    expect(
      normalized.filter((message) => message.role === 'assistant'),
    ).toHaveLength(2);
  });
});

describe('normalizeMessages filtering', () => {
  it('drops a message with no role', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      { content: 'orphan text' },
    ] as Message[];

    expect(roles(normalizeMessages(messages, false, false))).toEqual(['user']);
  });

  it('drops a message with neither content nor tool calls', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'assistant' },
    ] as Message[];

    expect(roles(normalizeMessages(messages, false, false))).toEqual(['user']);
  });

  it('leaves a contentless assistant turn alone instead of caching it', () => {
    const messages = [
      { role: 'user', content: 'review this' },
      assistantToolCall(),
      toolResult(),
    ] as Message[];

    const normalized = normalizeMessages(messages, false, false);
    const assistant = normalized.find(
      (message) => message.role === 'assistant',
    );

    expect(assistant).toEqual({
      role: 'assistant',
      tool_calls: toolCalls,
    });
  });
});
