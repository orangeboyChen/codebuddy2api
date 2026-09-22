import { describe, expect, it } from 'vitest';

import {
  collectAnthropicNestedImages,
  decodeOpaqueServerToolContent,
  formatAnthropicServerToolResult,
  mapAnthropicContentToChat,
  mapAnthropicMessagesToChat,
  mapAnthropicToolChoiceToChat,
  mapAnthropicToolsToChat,
} from '@/lib/server/proxy/anthropic/request';
import type {
  AnthropicContentBlock,
  AnthropicMessage,
} from '@/lib/server/proxy/anthropic/types';

/**
 * The Anthropic → chat request translation, at the edges.
 *
 * The ordinary text and tool-use paths are covered end to end elsewhere; what
 * is here is the shape handling around them: the opaque search results an
 * Anthropic client replays, the images a tool returned, and the tool
 * declarations and choices that decide who runs a tool.
 */
const block = (value: Record<string, unknown>): AnthropicContentBlock =>
  value as unknown as AnthropicContentBlock;

/** Base64 of `value`, the way an Anthropic client re-sends an opaque result. */
const opaque = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64');

describe('decodeOpaqueServerToolContent', () => {
  it('returns null for anything that is not a non-empty string', () => {
    expect(decodeOpaqueServerToolContent(null)).toBeNull();
    expect(decodeOpaqueServerToolContent(undefined)).toBeNull();
    expect(decodeOpaqueServerToolContent(42)).toBeNull();
    expect(decodeOpaqueServerToolContent({ title: 'Docs' })).toBeNull();
    expect(decodeOpaqueServerToolContent('')).toBeNull();
  });

  it('decodes a base64 JSON payload', () => {
    expect(
      decodeOpaqueServerToolContent(
        opaque({ title: 'Docs', url: 'https://d' }),
      ),
    ).toEqual({ title: 'Docs', url: 'https://d' });
  });

  it('returns null when the payload is not JSON', () => {
    expect(decodeOpaqueServerToolContent(opaque('not json at all'))).toBe(
      'not json at all',
    );
    expect(decodeOpaqueServerToolContent('!!!not base64!!!')).toBeNull();
  });
});

describe('formatAnthropicServerToolResult', () => {
  it('reads a search result the client replayed as opaque content', () => {
    const formatted = formatAnthropicServerToolResult(
      block({
        content: [
          {
            encrypted_content: opaque({
              content: 'A snippet',
              title: 'Docs',
              url: 'https://docs.test/release',
            }),
            type: 'web_search_result',
          },
        ],
        type: 'web_search_tool_result',
      }),
    );

    expect(formatted).toBe(
      ['1. Docs', 'URL: https://docs.test/release', 'A snippet'].join('\n'),
    );
  });

  it('falls back to the fields the result carries in the clear', () => {
    const formatted = formatAnthropicServerToolResult(
      block({
        content: [
          { title: 'Docs', url: 'https://docs.test/release' },
          { url: 'https://only-url.test' },
          // Neither a title nor a URL: the entry still has to be listed.
          { other: 'x' },
          // Not an object at all, so nothing can be read off it.
          'broken',
        ],
        type: 'web_search_tool_result',
      }),
    );

    expect(formatted).toBe(
      [
        '1. Docs',
        'URL: https://docs.test/release',
        '',
        '2. https://only-url.test',
        'URL: https://only-url.test',
        '',
        '3. Search result',
        '',
        '4. Search result',
      ].join('\n'),
    );
  });

  it('keeps a search result whose opaque payload will not decode', () => {
    const formatted = formatAnthropicServerToolResult(
      block({
        content: [
          {
            encrypted_content: 'not-decodable',
            title: 'Docs',
            url: 'https://docs.test/release',
          },
        ],
        type: 'web_search_tool_result',
      }),
    );

    expect(formatted).toContain('1. Docs');
    expect(formatted).toContain('URL: https://docs.test/release');
  });

  it('reads a fetched document out of its nested source', () => {
    const formatted = formatAnthropicServerToolResult(
      block({
        content: {
          content: { source: { data: 'The document body.' } },
          url: 'https://docs.test/page',
        },
        type: 'web_fetch_tool_result',
      }),
    );

    expect(formatted).toBe('https://docs.test/page\n\nThe document body.');
  });

  it('returns only what a fetched document carries', () => {
    expect(
      formatAnthropicServerToolResult(
        block({
          content: { url: 'https://docs.test/page' },
          type: 'web_fetch_tool_result',
        }),
      ),
    ).toBe('https://docs.test/page');
    expect(
      formatAnthropicServerToolResult(
        block({
          content: { content: { source: {} } },
          type: 'web_fetch_tool_result',
        }),
      ),
    ).toBe('');
    // Not an object, so it is not a fetch result at all: it falls through to
    // the ordinary string handling.
    expect(
      formatAnthropicServerToolResult(
        block({
          content: 'plain result',
          type: 'web_fetch_tool_result',
        }),
      ),
    ).toBe('plain result');
  });

  it('stringifies an ordinary tool result, without its images', () => {
    const formatted = formatAnthropicServerToolResult(
      block({
        content: [
          { text: 'plain result' },
          { source: { data: 'QUJD', type: 'base64' }, type: 'image' },
        ],
        tool_use_id: 'toolu_1',
        type: 'tool_result',
      }),
    );

    expect(formatted).toContain('plain result');
    // The base64 payload would otherwise reach the model as prose.
    expect(formatted).not.toContain('QUJD');
  });

  it('returns string content as it stands', () => {
    expect(
      formatAnthropicServerToolResult(
        block({ content: 'plain result', type: 'tool_result' }),
      ),
    ).toBe('plain result');
  });
});

describe('collectAnthropicNestedImages', () => {
  it('returns nothing when there is no content array', () => {
    expect(
      collectAnthropicNestedImages(block({ content: 'plain', type: 'x' })),
    ).toEqual([]);
    expect(collectAnthropicNestedImages(block({ type: 'x' }))).toEqual([]);
  });

  it('skips entries that are not images', () => {
    expect(
      collectAnthropicNestedImages(
        block({
          content: ['text', null, { text: 'a result', type: 'text' }],
          type: 'tool_result',
        }),
      ),
    ).toEqual([]);
  });

  it('keeps an image a tool returned', () => {
    expect(
      collectAnthropicNestedImages(
        block({
          content: [
            { text: 'a screenshot' },
            { source: { data: 'QUJD', type: 'base64' }, type: 'image' },
          ],
          type: 'tool_result',
        }),
      ),
    ).toEqual([
      { image_url: { url: 'data:image/png;base64,QUJD' }, type: 'image_url' },
    ]);
  });
});

describe('mapAnthropicContentToChat', () => {
  it('flushes the assistant turn before a result it carries', () => {
    const messages = mapAnthropicContentToChat(
      [
        { text: 'Let me look that up.', type: 'text' },
        {
          content: [{ text: 'plain result' }],
          tool_use_id: 'toolu_1',
          type: 'tool_result',
        },
      ],
      'assistant',
    );

    expect(messages).toEqual([
      { content: 'Let me look that up.', role: 'assistant' },
      { content: 'plain result', role: 'tool', tool_call_id: 'toolu_1' },
    ]);
  });

  it('sends an image a tool returned as an image part, not as text', () => {
    const messages = mapAnthropicContentToChat(
      [
        {
          content: [
            { text: 'a screenshot' },
            { source: { data: 'QUJD', type: 'base64' }, type: 'image' },
          ],
          tool_use_id: 'toolu_1',
          type: 'tool_result',
        },
      ],
      'user',
    );

    expect(messages).toEqual([
      {
        content: [
          { text: 'a screenshot', type: 'text' },
          {
            image_url: { url: 'data:image/png;base64,QUJD' },
            type: 'image_url',
          },
        ],
        role: 'tool',
        tool_call_id: 'toolu_1',
      },
    ]);
  });

  it('drops a message that was nothing but the client usage hint', () => {
    const hint =
      '<system-reminder>Token usage: 12 / 200000; 199988 remaining</system-reminder>';
    const messages: AnthropicMessage[] = [
      { content: [{ text: hint, type: 'text' }], role: 'user' },
      // The hint rides along in the same block as the real text, so a message
      // carrying both is sent with the hint removed.
      {
        content: [{ text: `${hint}Look this up.`, type: 'text' }],
        role: 'user',
      },
    ];

    expect(mapAnthropicMessagesToChat(messages)).toEqual([
      { content: 'Look this up.', role: 'user' },
    ]);
  });
});

describe('mapAnthropicToolsToChat', () => {
  it('returns undefined for no tools', () => {
    expect(mapAnthropicToolsToChat(undefined)).toBeUndefined();
    expect(mapAnthropicToolsToChat([])).toBeUndefined();
  });

  it('keeps a server tool distinguishable from a client function', () => {
    expect(
      mapAnthropicToolsToChat([
        {
          input_schema: { type: 'object' },
          max_uses: 3,
          name: 'web_search',
          type: 'web_search_20250305',
        },
      ]),
    ).toEqual([
      {
        function: { name: 'web_search' },
        input_schema: { type: 'object' },
        max_uses: 3,
        name: 'web_search',
        type: 'web_search_20250305',
      },
    ]);
  });

  it('flattens the client own tools, including one named for a server tool', () => {
    expect(
      mapAnthropicToolsToChat([
        {
          description: 'Search the web',
          input_schema: { type: 'object' },
          name: 'WebSearch',
        },
        {
          description: 'Fetch a page',
          input_schema: { type: 'object' },
          // Not a provider-executed type, so it stays the client's to resolve.
          name: 'WebFetch',
          type: 'custom',
        },
      ]),
    ).toEqual([
      {
        function: {
          description: 'Search the web',
          name: 'WebSearch',
          parameters: { type: 'object' },
        },
        type: 'function',
      },
      {
        function: {
          description: 'Fetch a page',
          name: 'WebFetch',
          parameters: { type: 'object' },
        },
        type: 'function',
      },
    ]);
  });
});

describe('mapAnthropicToolChoiceToChat', () => {
  it('passes through a choice that is not an object', () => {
    expect(mapAnthropicToolChoiceToChat('auto')).toBe('auto');
    expect(mapAnthropicToolChoiceToChat(undefined)).toBeUndefined();
    expect(mapAnthropicToolChoiceToChat(null)).toBeNull();
  });

  it('maps the named choices', () => {
    expect(mapAnthropicToolChoiceToChat({ type: 'auto' })).toBe('auto');
    expect(
      mapAnthropicToolChoiceToChat({
        disable_parallel_tool_use: true,
        type: 'any',
      }),
    ).toBe('required');
    expect(mapAnthropicToolChoiceToChat({ type: 'none' })).toBe('none');
  });

  it('pins one tool by name', () => {
    expect(
      mapAnthropicToolChoiceToChat({ name: 'WebSearch', type: 'tool' }),
    ).toEqual({ function: { name: 'WebSearch' }, type: 'function' });
  });

  it('hands back a shape it does not recognise', () => {
    const choice = { name: 'WebSearch', type: 'tool' };

    // A pinned tool with no name has nothing to pin, so it is left alone
    // rather than rewritten into a choice upstream would reject.
    expect(mapAnthropicToolChoiceToChat({ type: 'tool' })).toEqual({
      type: 'tool',
    });
    expect(mapAnthropicToolChoiceToChat({ type: 'other' })).toEqual({
      type: 'other',
    });
    expect(mapAnthropicToolChoiceToChat(choice)).not.toBe(choice);
  });
});
