import fs from 'node:fs';
import path from 'node:path';

import { NextRequest } from 'next/server';

import {
  getSettingLabels,
  isWebSearchEnabled,
  updateSettings,
} from '@/lib/server/domain/config';
import {
  getWebSearchProvider,
  isLocalWebSearchConfigured,
  resetWebSearchProviders,
  resolveSearchProvider,
  runWebSearch,
} from '@/lib/server/search';
import {
  createSearxngProvider,
  createSearxngProviderFromEnv,
} from '@/lib/server/search/providers/searxng';
import { buildWebSearchToolDefinition } from '@/lib/server/search/tool';
import {
  createProxyContextFromCredential,
  proxyChatCompletions,
} from '@/lib/server/proxy/codebuddy';
import {
  addCredential,
  resetCredentialRuntimeState,
} from '@/lib/server/domain/credentials';
import { resetUsageStats } from '@/lib/server/domain/stats';
import type { ChatRequestBody } from '@/lib/server/proxy/codebuddy';
import { translateResponsesToolsToChat } from '@/lib/server/proxy/responses';
import { handleResponsesRequest } from '@/lib/server/proxy/responses';
import { handleMessagesRequest } from '@/lib/server/proxy/anthropic';
import {
  executeWebSearchLoop,
  synthesizeChatCompletionStream,
} from '@/lib/server/proxy/web-search-loop';

const SEARXNG_ENV_NAMES = [
  'SEARXNG_URL',
  'SEARXNG_API_KEY',
  'SEARXNG_ENGINES',
  'SEARXNG_LANGUAGE',
  'SEARXNG_MAX_RESULTS',
  'SEARXNG_TIMEOUT_MS',
] as const;

const clearSearxngEnv = (): void => {
  for (const name of SEARXNG_ENV_NAMES) {
    delete process.env[name];
  }
  resetWebSearchProviders();
};

const makeJsonResponse = (
  payload: Record<string, unknown>,
  status = 200,
): Response => {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
};

const makeSseResponse = (...chunks: Record<string, unknown>[]): Response =>
  new Response(
    `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`,
    { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } },
  );

type LoopCall = (body: ChatRequestBody) => Promise<Response>;

/**
 * Reads the loop's buffered payload, asserting the loop ran.
 *
 * `executeWebSearchLoop` legitimately returns a null response when no backend
 * can execute the declared tools, so every assertion on the payload has to rule
 * that out first rather than silently reading through a nullable.
 */
const readPayload = async (
  result: { response: Response | null } | null,
): Promise<Record<string, unknown>> => {
  if (!result?.response) {
    throw new Error('Expected the server-tool loop to produce a response');
  }

  return (await result.response.json()) as Record<string, unknown>;
};

const readSseEvents = async (response: Response): Promise<string[]> => {
  const text = await response.text();

  return text
    .split('\n\n')
    .map((frame) =>
      frame
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice(6))
        .join(''),
    )
    .filter((payload) => payload.length > 0);
};

describe('server local web search', () => {
  beforeEach(() => {
    clearSearxngEnv();
  });

  afterEach(() => {
    clearSearxngEnv();
    vi.restoreAllMocks();
  });

  describe('provider registry', () => {
    it('reports no backend when SEARXNG_URL is unset', () => {
      expect(isLocalWebSearchConfigured()).toBe(false);
      expect(getWebSearchProvider()).toBeNull();
    });

    it('ignores a non-absolute SEARXNG_URL', () => {
      process.env.SEARXNG_URL = 'searx.example.com/search';
      resetWebSearchProviders();

      expect(isLocalWebSearchConfigured()).toBe(false);
    });

    it('resolves a SearXNG provider from the environment', () => {
      process.env.SEARXNG_URL = 'https://searx.example.com/';
      process.env.SEARXNG_MAX_RESULTS = '3';
      resetWebSearchProviders();

      expect(isLocalWebSearchConfigured()).toBe(true);
      expect(getWebSearchProvider()?.id).toBe('searxng');
    });

    it('reports an unconfigured backend when a query is attempted', async () => {
      await expect(runWebSearch({ query: 'hello' })).resolves.toContain(
        'no local search backend is configured',
      );
    });

    it('converts provider failures into text instead of throwing', async () => {
      await expect(
        runWebSearch({
          provider: {
            id: 'boom',
            search: async () => {
              throw new Error('connection refused');
            },
          },
          query: 'hello',
        }),
      ).resolves.toContain('connection refused');
    });

    it('reports a timeout as text', async () => {
      await expect(
        runWebSearch({
          provider: {
            id: 'slow',
            search: async () => {
              throw Object.assign(new Error('aborted'), {
                name: 'AbortError',
              });
            },
          },
          query: 'hello',
        }),
      ).resolves.toContain('timed out');
    });

    it('reports a non-Error rejection as an unknown failure', async () => {
      await expect(
        runWebSearch({
          provider: {
            id: 'weird',
            search: async () => {
              throw 'a string';
            },
          },
          query: 'hello',
        }),
      ).resolves.toContain('unknown error');
    });

    it('caches the resolved provider until it is reset', () => {
      process.env.SEARXNG_URL = 'https://searx.example.com';
      resetWebSearchProviders();
      const first = getWebSearchProvider();

      expect(getWebSearchProvider()).toBe(first);

      delete process.env.SEARXNG_URL;
      expect(getWebSearchProvider()).toBe(first);

      resetWebSearchProviders();
      expect(getWebSearchProvider()).toBeNull();
    });
  });

  describe('searxng provider', () => {
    it('queries the instance and formats results', async () => {
      const fetchMock = vi.fn(
        async () =>
          makeJsonResponse({
            results: [
              { content: 'Snippet one', title: 'First', url: 'https://a.test' },
              {
                content: 'Snippet two',
                title: 'Second',
                url: 'https://b.test',
              },
            ],
          }) as unknown as Response,
      );
      vi.stubGlobal('fetch', fetchMock);

      const provider = createSearxngProvider({ url: 'https://searx.test/' });
      const result = await provider.search('latest news');

      const [url] = fetchMock.mock.calls[0] as unknown as [string];
      expect(url).toContain('https://searx.test/search?');
      expect(url).toContain('q=latest+news');
      expect(result.results).toHaveLength(2);
      expect(result.content).toContain('First');
      expect(result.content).toContain('https://a.test');
      expect(result.content).toContain('Snippet two');
    });

    it('sends the API key header when one is configured', async () => {
      const fetchMock = vi.fn(
        async () => makeJsonResponse({ results: [] }) as unknown as Response,
      );
      vi.stubGlobal('fetch', fetchMock);

      await createSearxngProvider({
        apiKey: 'secret-key',
        url: 'https://searx.test',
      }).search('q');

      const [, init] = fetchMock.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];
      expect(new Headers(init.headers).get('X-API-Key')).toBe('secret-key');
    });

    it('selects engines with bang syntax inside the query', async () => {
      const fetchMock = vi.fn(
        async () => makeJsonResponse({ results: [] }) as unknown as Response,
      );
      vi.stubGlobal('fetch', fetchMock);

      await createSearxngProvider({
        engines: 'google,bing',
        language: 'zh',
        url: 'https://searx.test',
      }).search('latest news');

      const [url] = fetchMock.mock.calls[0] as unknown as [string];
      // No `engines` parameter exists; selection rides in `q` as bang tokens.
      expect(url).not.toContain('engines=');
      expect(url).toContain('language=zh');
      const query = new URL(url).searchParams.get('q');
      expect(query).toBe('!google !bing latest news');
    });

    it('applies the language on its own when no engines are set', async () => {
      const fetchMock = vi.fn(
        async () => makeJsonResponse({ results: [] }) as unknown as Response,
      );
      vi.stubGlobal('fetch', fetchMock);

      await createSearxngProvider({
        language: 'zh',
        url: 'https://searx.test',
      }).search('latest news');

      const [url] = fetchMock.mock.calls[0] as unknown as [string];
      expect(url).toContain('language=zh');
      expect(new URL(url).searchParams.get('q')).toBe('latest news');
    });

    it('strips redundant bang prefixes and rejects unsafe engine names', async () => {
      const fetchMock = vi.fn(
        async () => makeJsonResponse({ results: [] }) as unknown as Response,
      );
      vi.stubGlobal('fetch', fetchMock);

      await createSearxngProvider({
        engines: '!!google  bang "bad name"  ok-engine ',
        url: 'https://searx.test',
      }).search('q');

      const [url] = fetchMock.mock.calls[0] as unknown as [string];
      // Only whole-token names survive; anything else is dropped.
      expect(new URL(url).searchParams.get('q')).toBe(
        '!google !bang !ok-engine q',
      );
    });

    it('limits results to the configured maximum', async () => {
      const fetchMock = vi.fn(
        async () =>
          makeJsonResponse({
            results: Array.from({ length: 8 }, (_, index) => ({
              title: `Result ${index}`,
              url: `https://${index}.test`,
            })),
          }) as unknown as Response,
      );
      vi.stubGlobal('fetch', fetchMock);

      const result = await createSearxngProvider({
        maxResults: 2,
        url: 'https://searx.test',
      }).search('q');

      expect(result.results).toHaveLength(2);
    });

    it('reports empty results as text the model can act on', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () => makeJsonResponse({ results: [] }) as unknown as Response,
        ),
      );

      const result = await createSearxngProvider({
        url: 'https://searx.test',
      }).search('nothing here');

      expect(result.content).toContain('returned no results');
    });

    it('surfaces an HTTP failure from the instance', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response('nope', { status: 503 }) as unknown as Response,
        ),
      );

      const provider = createSearxngProvider({ url: 'https://searx.test' });

      await expect(provider.search('q')).rejects.toThrow('HTTP 503');
    });

    it('explains that JSON output is disabled on a 403', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response('forbidden', { status: 403 }) as unknown as Response,
        ),
      );

      const provider = createSearxngProvider({ url: 'https://searx.test' });

      // The JSON format is opt-in on the instance, so the error has to point
      // at settings.yml rather than reading like an auth failure.
      await expect(provider.search('q')).rejects.toThrow(/search\.formats/);

      // The message reaches the model as text, not a thrown error.
      process.env.SEARXNG_URL = 'https://searx.test';
      resetWebSearchProviders();
      await expect(runWebSearch({ query: 'q' })).resolves.toContain(
        'search.formats',
      );
    });

    it('returns null from the env factory when the URL is missing', () => {
      expect(createSearxngProviderFromEnv()).toBeNull();
    });

    it('treats a whitespace-only query as an empty search', async () => {
      const fetchMock = vi.fn(async () => makeJsonResponse({ results: [] }));
      vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

      const result = await createSearxngProvider({
        url: 'https://searx.test',
      }).search('   ');

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.content).toContain('without a query');
    });

    it('handles results missing titles, urls, and snippets', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          makeJsonResponse({ results: [{}, { title: 'Only title' }] }),
        ) as unknown as typeof fetch,
      );

      const result = await createSearxngProvider({
        url: 'https://searx.test',
      }).search('q');

      expect(result.results).toHaveLength(2);
      expect(result.content).toContain('(untitled)');
      expect(result.content).toContain('Only title');
      // An entry with no URL renders its title as the citation source.
      expect(result.content).toContain('2. Only title');
    });

    it('tolerates a payload with no results array', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => makeJsonResponse({})) as unknown as typeof fetch,
      );

      const result = await createSearxngProvider({
        url: 'https://searx.test',
      }).search('q');

      expect(result.results).toEqual([]);
      expect(result.content).toContain('returned no results');
    });

    it('falls back to defaults for non-numeric environment overrides', () => {
      process.env.SEARXNG_URL = 'https://searx.example.com';
      process.env.SEARXNG_MAX_RESULTS = 'not-a-number';
      process.env.SEARXNG_TIMEOUT_MS = 'also-not-a-number';
      resetWebSearchProviders();

      expect(isLocalWebSearchConfigured()).toBe(true);
    });

    it('clamps out-of-range environment overrides', () => {
      process.env.SEARXNG_URL = 'https://searx.example.com';
      process.env.SEARXNG_MAX_RESULTS = '99';
      process.env.SEARXNG_TIMEOUT_MS = '1';
      resetWebSearchProviders();

      expect(isLocalWebSearchConfigured()).toBe(true);
    });

    it('reads optional settings from the environment', async () => {
      process.env.SEARXNG_URL = 'https://searx.example.com/';
      process.env.SEARXNG_API_KEY = 'env-key';
      process.env.SEARXNG_ENGINES = 'brave';
      process.env.SEARXNG_LANGUAGE = 'de';
      resetWebSearchProviders();

      const fetchMock = vi.fn(async () => makeJsonResponse({ results: [] }));
      vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

      await runWebSearch({ query: 'hallo' });

      const [url, init] = fetchMock.mock.calls[0] as unknown as [
        string,
        RequestInit,
      ];
      expect(url).toContain('https://searx.example.com/search?');
      expect(new URL(url).searchParams.get('q')).toBe('!brave hallo');
      expect(url).toContain('language=de');
      expect(new Headers(init.headers).get('X-API-Key')).toBe('env-key');
    });
  });

  describe('tool definition', () => {
    it('advertises a query-only function tool', () => {
      const tool = buildWebSearchToolDefinition();

      expect(tool.name).toBe('web_search');
      expect(tool.parameters).toMatchObject({
        properties: { query: { type: 'string' } },
        required: ['query'],
        type: 'object',
      });
    });
  });

  describe('query extraction', () => {
    const runOnce = async (rawArguments: string | undefined) => {
      const fetchMock = vi.fn(async () => makeJsonResponse({ results: [] }));
      vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
      process.env.SEARXNG_URL = 'https://searx.test';
      resetWebSearchProviders();
      await updateSettings({ CODEBUDDY_WEB_SEARCH_BACKEND: 'searxng' });

      let call = 0;
      const callUpstream = vi.fn<LoopCall>(async () => {
        call += 1;

        return call === 1
          ? makeJsonResponse({
              choices: [
                {
                  finish_reason: 'tool_calls',
                  message: {
                    tool_calls: [
                      {
                        id: 'c1',
                        function: {
                          arguments: rawArguments,
                          name: 'web_search',
                        },
                      },
                    ],
                  },
                },
              ],
            })
          : makeJsonResponse({
              choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
            });
      });

      await executeWebSearchLoop({
        body: {
          messages: [{ content: 'hi', role: 'user' }],
          tools: [{ type: 'web_search_preview' }],
        },
        callUpstream,
      });

      if (!fetchMock.mock.calls.length) {
        return null;
      }

      const [url] = fetchMock.mock.calls[0] as unknown as [string];

      return new URL(url).searchParams.get('q');
    };

    beforeEach(() => {
      clearSearxngEnv();
    });

    afterEach(() => {
      clearSearxngEnv();
    });

    it('reads a bare JSON string argument', async () => {
      await expect(runOnce('"bare query"')).resolves.toBe('bare query');
    });

    it('reads a nested Anthropic-style query object', async () => {
      await expect(runOnce('{"query":{"q":"nested query"}}')).resolves.toBe(
        'nested query',
      );
    });

    it('falls back to the first non-empty string field', async () => {
      await expect(runOnce('{"topic":"fallback value"}')).resolves.toBe(
        'fallback value',
      );
    });

    it('skips the search for a non-object argument payload', async () => {
      // No query can be recovered, so no request is made and the loop reports
      // that back to the model as tool result text.
      await expect(runOnce('42')).resolves.toBeNull();
    });

    it('reads search_query and text aliases', async () => {
      await expect(runOnce('{"search_query":"alias one"}')).resolves.toBe(
        'alias one',
      );
      await expect(runOnce('{"text":"alias two"}')).resolves.toBe('alias two');
    });
  });

  describe('search loop', () => {
    const enableSearch = async (): Promise<void> => {
      process.env.SEARXNG_URL = 'https://searx.test';
      resetWebSearchProviders();
      await updateSettings({ CODEBUDDY_WEB_SEARCH_BACKEND: 'searxng' });
    };

    it('skips requests that declare no web search tool', async () => {
      await enableSearch();
      const callUpstream = vi.fn<LoopCall>(async () => makeJsonResponse({}));

      await expect(
        executeWebSearchLoop({
          body: { messages: [{ content: 'hi', role: 'user' }], tools: [] },
          callUpstream,
        }),
      ).resolves.toBeNull();
      expect(callUpstream).not.toHaveBeenCalled();
    });

    it('does not run the loop when the setting is disabled', async () => {
      process.env.SEARXNG_URL = 'https://searx.test';
      resetWebSearchProviders();
      // Both off: the loop runs if *either* tool can be executed, so leaving
      // fetch enabled would make it call upstream regardless of search.
      await updateSettings({
        CODEBUDDY_WEB_FETCH_BACKEND: 'passthrough',
        CODEBUDDY_WEB_SEARCH_BACKEND: 'passthrough',
      });
      const callUpstream = vi.fn<LoopCall>(async () => makeJsonResponse({}));

      const result = await executeWebSearchLoop({
        body: {
          messages: [{ content: 'hi', role: 'user' }],
          tools: [{ type: 'web_search_20260209', name: 'web_search' }],
        },
        callUpstream,
      });

      // No upstream call: nothing can execute, so there is nothing to loop for.
      expect(callUpstream).not.toHaveBeenCalled();
      expect(result?.response).toBeNull();
      expect(result?.body.tools).toEqual([
        { type: 'web_search_20260209', name: 'web_search' },
      ]);
    });

    it('drops an unconfigured non-passthrough server declaration', async () => {
      await updateSettings({ CODEBUDDY_WEB_SEARCH_BACKEND: 'searxng' });
      const callUpstream = vi.fn<LoopCall>(async () => makeJsonResponse({}));

      const result = await executeWebSearchLoop({
        body: {
          messages: [{ content: 'hi', role: 'user' }],
          tools: [{ type: 'web_search_20260209', name: 'web_search' }],
        },
        callUpstream,
      });

      expect(callUpstream).not.toHaveBeenCalled();
      expect(result?.body.tools).toEqual([]);
    });

    it.each([
      [
        'anthropic server tool',
        { type: 'web_search_20260209', name: 'web_search' },
      ],
      [
        'anthropic legacy tool',
        { type: 'web_search_20250305', name: 'web_search' },
      ],
      ['responses preview tool', { type: 'web_search_preview' }],
    ])('replaces the %s with a callable function', async (_label, tool) => {
      await enableSearch();
      const callUpstream = vi.fn<LoopCall>(async () =>
        makeJsonResponse({
          choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
        }),
      );

      const result = await executeWebSearchLoop({
        body: { messages: [{ content: 'hi', role: 'user' }], tools: [tool] },
        callUpstream,
      });

      expect(result).not.toBeNull();
      const upstreamBody = callUpstream.mock.calls[0]?.[0] as ChatRequestBody;
      const tools = upstreamBody.tools as Array<{
        function: { name: string };
      }>;
      expect(tools.map((entry) => entry.function.name)).toEqual(['web_search']);
    });

    it('runs the query and feeds results back to the model', async () => {
      await enableSearch();
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          makeJsonResponse({
            results: [
              { content: 'A snippet', title: 'Docs', url: 'https://docs.test' },
            ],
          }),
        ) as unknown as typeof fetch,
      );

      let call = 0;
      const callUpstream = vi.fn<LoopCall>(async () => {
        call += 1;

        return call === 1
          ? makeJsonResponse({
              choices: [
                {
                  finish_reason: 'tool_calls',
                  message: {
                    content: null,
                    role: 'assistant',
                    tool_calls: [
                      {
                        id: 'call_1',
                        type: 'function',
                        function: {
                          arguments: '{"query":"current weather"}',
                          name: 'web_search',
                        },
                      },
                    ],
                  },
                },
              ],
            })
          : makeJsonResponse({
              choices: [
                { finish_reason: 'stop', message: { content: 'It is sunny.' } },
              ],
            });
      });

      const result = await executeWebSearchLoop({
        body: {
          messages: [{ content: 'weather?', role: 'user' }],
          tools: [{ type: 'web_search_20260209', name: 'web_search' }],
        },
        callUpstream,
      });

      expect(callUpstream).toHaveBeenCalledTimes(2);
      const payload = (await readPayload(result)) as {
        choices: Array<{ message: { content: string } }>;
      };
      expect(payload.choices[0]?.message.content).toBe('It is sunny.');

      const secondCallBody = callUpstream.mock.calls[1]?.[0] as ChatRequestBody;
      const secondMessages = (secondCallBody.messages ?? []) as Array<
        Record<string, unknown>
      >;
      const toolMessage = secondMessages
        .filter((message) => message.role === 'tool')
        .at(-1);
      expect(String(toolMessage?.content)).toContain('https://docs.test');
      expect(toolMessage?.tool_call_id).toBe('call_1');
    });

    it('accepts alternate query argument shapes', async () => {
      await enableSearch();
      const fetchMock = vi.fn(async () => makeJsonResponse({ results: [] }));
      vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

      const callUpstream = vi.fn<LoopCall>(async () =>
        makeJsonResponse({
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                tool_calls: [
                  {
                    id: 'call_q',
                    function: {
                      arguments: '{"q":"alternate query"}',
                      name: 'web_search',
                    },
                  },
                ],
              },
            },
          ],
        }),
      );

      await executeWebSearchLoop({
        body: {
          messages: [{ content: 'hi', role: 'user' }],
          tools: [{ type: 'web_search_preview' }],
        },
        callUpstream,
      });

      const [url] = fetchMock.mock.calls[0] as unknown as [string];
      expect(url).toContain('q=alternate+query');
    });

    it('stops after the iteration cap when the model keeps searching', async () => {
      await enableSearch();
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          makeJsonResponse({ results: [] }),
        ) as unknown as typeof fetch,
      );

      // The model always asks to search; only the final call, which has the
      // search tool withdrawn, produces an answer.
      const callUpstream = vi.fn<LoopCall>(async (body) => {
        const hasSearchTool = (
          (body.tools ?? []) as Array<{
            function?: { name?: string };
          }>
        ).some((tool) => tool.function?.name === 'web_search');

        return hasSearchTool
          ? makeJsonResponse({
              choices: [
                {
                  finish_reason: 'tool_calls',
                  message: {
                    tool_calls: [
                      {
                        id: 'call_loop',
                        function: {
                          arguments: '{"query":"again"}',
                          name: 'web_search',
                        },
                      },
                    ],
                  },
                },
              ],
            })
          : makeJsonResponse({
              choices: [
                { finish_reason: 'stop', message: { content: 'Enough.' } },
              ],
            });
      });

      const result = await executeWebSearchLoop({
        body: {
          messages: [{ content: 'hi', role: 'user' }],
          tools: [{ type: 'web_search_preview' }],
        },
        callUpstream,
      });

      // 5 search iterations plus one final call with the search tool removed.
      expect(callUpstream).toHaveBeenCalledTimes(6);

      const finalBody = callUpstream.mock.calls[5]?.[0] as ChatRequestBody;
      expect(finalBody.tools).toEqual([]);

      const payload = (await readPayload(result)) as {
        choices: Array<{ message: { content?: string } }>;
      };
      expect(payload.choices[0]?.message.content).toBe('Enough.');
      expect(result?.response?.ok).toBe(true);
    });

    it('preserves unrelated tools and passes through non-search tool calls', async () => {
      await enableSearch();
      const callUpstream = vi.fn<LoopCall>(async () =>
        makeJsonResponse({
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                tool_calls: [
                  {
                    id: 'call_other',
                    function: { arguments: '{}', name: 'read_file' },
                  },
                ],
              },
            },
          ],
        }),
      );
      const fetchMock = vi.fn(async () => makeJsonResponse({ results: [] }));
      vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

      const result = await executeWebSearchLoop({
        body: {
          messages: [{ content: 'hi', role: 'user' }],
          tools: [
            { type: 'web_search_preview' },
            { type: 'function', function: { name: 'read_file' } },
          ],
        },
        callUpstream,
      });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(callUpstream).toHaveBeenCalledTimes(1);
      const payload = (await readPayload(result)) as {
        choices: Array<{ message: { tool_calls?: unknown[] } }>;
      };
      expect(payload.choices[0]?.message.tool_calls).toHaveLength(1);
    });

    it('folds search findings into text when a turn mixes search and client calls', async () => {
      await enableSearch();
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          makeJsonResponse({
            results: [
              {
                content: 'Docs snippet',
                title: 'Docs',
                url: 'https://docs.test',
              },
            ],
          }),
        ) as unknown as typeof fetch,
      );
      const callUpstream = vi.fn<LoopCall>(async () =>
        makeJsonResponse({
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                content: 'Checking now.',
                tool_calls: [
                  {
                    id: 'call_search',
                    function: {
                      arguments: '{"query":"release date"}',
                      name: 'web_search',
                    },
                  },
                  {
                    id: 'call_read',
                    function: { arguments: '{"path":"a"}', name: 'read_file' },
                  },
                ],
              },
            },
          ],
          usage: { total_tokens: 12 },
        }),
      );

      const result = await executeWebSearchLoop({
        body: {
          messages: [{ content: 'hi', role: 'user' }],
          tools: [
            { type: 'web_search_preview' },
            { type: 'function', function: { name: 'read_file' } },
          ],
        },
        callUpstream,
      });

      // The loop stops after one iteration instead of continuing with a
      // transcript that has no result for read_file.
      expect(callUpstream).toHaveBeenCalledTimes(1);

      const payload = (await readPayload(result)) as {
        choices: Array<{
          finish_reason: string | null;
          message: {
            content: string | null;
            tool_calls?: Array<{ function?: { name?: string }; id?: string }>;
          };
        }>;
        usage?: { total_tokens?: number };
      };
      const choice = payload.choices[0];

      expect(choice?.finish_reason).toBe('tool_calls');
      expect(choice?.message.content).toContain('Checking now.');
      expect(choice?.message.content).toContain('https://docs.test');
      // Only the client-owned call is handed back.
      expect(choice?.message.tool_calls).toHaveLength(1);
      expect(choice?.message.tool_calls?.[0]?.id).toBe('call_read');
      expect(payload.usage?.total_tokens).toBe(12);
    });

    it('keeps a mixed turn that carries usage alongside findings', async () => {
      await enableSearch();
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          makeJsonResponse({ results: [] }),
        ) as unknown as typeof fetch,
      );
      const callUpstream = vi.fn<LoopCall>(async () =>
        makeJsonResponse({
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                tool_calls: [
                  {
                    id: 'call_search',
                    function: {
                      arguments: '{"query":"x"}',
                      name: 'web_search',
                    },
                  },
                  {
                    id: 'call_read',
                    function: { arguments: '{}', name: 'read_file' },
                  },
                ],
              },
            },
          ],
          usage: { total_tokens: 3 },
        }),
      );

      const result = await executeWebSearchLoop({
        body: {
          messages: [{ content: 'hi', role: 'user' }],
          tools: [{ type: 'web_search_preview' }],
        },
        callUpstream,
      });

      const payload = (await readPayload(result)) as {
        choices: Array<{ message: { tool_calls?: unknown[] } }>;
        usage?: { total_tokens?: number };
      };

      expect(payload.choices[0]?.message.tool_calls).toHaveLength(1);
      expect(payload.usage?.total_tokens).toBe(3);
    });

    it('omits usage from a mixed turn when upstream reports none', async () => {
      await enableSearch();
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          makeJsonResponse({ results: [] }),
        ) as unknown as typeof fetch,
      );
      const callUpstream = vi.fn<LoopCall>(async () =>
        makeJsonResponse({
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                content: 'partial',
                tool_calls: [
                  {
                    id: 'call_search',
                    function: {
                      arguments: '{"query":"x"}',
                      name: 'web_search',
                    },
                  },
                  {
                    id: 'call_read',
                    function: { arguments: '{}', name: 'read_file' },
                  },
                ],
              },
            },
          ],
        }),
      );

      const result = await executeWebSearchLoop({
        body: {
          messages: [{ content: 'hi', role: 'user' }],
          tools: [{ type: 'web_search_preview' }],
        },
        callUpstream,
      });

      const payload = (await readPayload(result)) as {
        choices: Array<{ message: { content: string | null } }>;
        usage?: unknown;
      };

      expect(payload.choices[0]?.message.content).toContain('partial');
      expect(payload.usage).toBeUndefined();
    });

    it('leaves non-primary choices untouched in a mixed turn', async () => {
      await enableSearch();
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          makeJsonResponse({
            results: [
              { content: 'snippet', title: 'T', url: 'https://t.test' },
            ],
          }),
        ) as unknown as typeof fetch,
      );
      const callUpstream = vi.fn<LoopCall>(async () =>
        makeJsonResponse({
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                tool_calls: [
                  {
                    id: 'call_search',
                    function: {
                      arguments: '{"query":"x"}',
                      name: 'web_search',
                    },
                  },
                  { id: 'call_read', function: { name: 'read_file' } },
                ],
              },
            },
            { finish_reason: 'stop', message: { content: 'second choice' } },
          ],
        }),
      );

      const result = await executeWebSearchLoop({
        body: {
          messages: [{ content: 'hi', role: 'user' }],
          tools: [{ type: 'web_search_preview' }],
        },
        callUpstream,
      });

      const payload = (await readPayload(result)) as {
        choices: Array<{
          finish_reason: string | null;
          message: { content: string | null; tool_calls?: unknown[] };
        }>;
      };

      // The second choice passes through unchanged.
      expect(payload.choices[1]?.message.content).toBe('second choice');
      // The first is rewritten to carry the findings.
      expect(payload.choices[0]?.message.content).toContain('https://t.test');
      expect(payload.choices[0]?.message.tool_calls).toHaveLength(1);
    });

    it('truncates long snippets and titles in the rendered findings', async () => {
      await enableSearch();
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          makeJsonResponse({
            results: [
              {
                content: 'word '.repeat(400),
                title: 'T'.repeat(400),
                url: 'https://long.test',
              },
            ],
          }),
        ) as unknown as typeof fetch,
      );
      const callUpstream = vi.fn<LoopCall>(async () =>
        makeJsonResponse({
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                tool_calls: [
                  {
                    id: 'call_search',
                    function: {
                      arguments: '{"query":"x"}',
                      name: 'web_search',
                    },
                  },
                  { id: 'call_read', function: { name: 'read_file' } },
                ],
              },
            },
          ],
        }),
      );

      const result = await executeWebSearchLoop({
        body: {
          messages: [{ content: 'hi', role: 'user' }],
          tools: [{ type: 'web_search_preview' }],
        },
        callUpstream,
      });

      const payload = (await readPayload(result)) as {
        choices: Array<{ message: { content: string | null } }>;
      };
      const content = payload.choices[0]?.message.content ?? '';

      // Both the title and the snippet are capped, marked with an ellipsis.
      expect(content).toContain('…');
      expect(content.length).toBeLessThan(1400);
    });

    it('carries findings without prior text in a mixed turn', async () => {
      await enableSearch();
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          makeJsonResponse({
            results: [
              { content: 'snippet', title: 'T', url: 'https://t.test' },
            ],
          }),
        ) as unknown as typeof fetch,
      );
      const callUpstream = vi.fn<LoopCall>(async () =>
        makeJsonResponse({
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'call_search',
                    function: {
                      arguments: '{"query":"x"}',
                      name: 'web_search',
                    },
                  },
                  {
                    id: 'call_read',
                    function: { arguments: '{}', name: 'read_file' },
                  },
                ],
              },
            },
          ],
        }),
      );

      const result = await executeWebSearchLoop({
        body: {
          messages: [{ content: 'hi', role: 'user' }],
          tools: [{ type: 'web_search_preview' }],
        },
        callUpstream,
      });

      const payload = (await readPayload(result)) as {
        choices: Array<{ message: { content: string | null } }>;
      };

      expect(payload.choices[0]?.message.content).toContain('https://t.test');
    });

    it('returns the upstream error response unchanged', async () => {
      await enableSearch();
      const callUpstream = vi.fn<LoopCall>(async () =>
        makeJsonResponse({ error: { message: 'boom' } }, 502),
      );

      const result = await executeWebSearchLoop({
        body: {
          messages: [{ content: 'hi', role: 'user' }],
          tools: [{ type: 'web_search_preview' }],
        },
        callUpstream,
      });

      expect(result?.response?.ok).toBe(false);
      expect(result?.response?.status).toBe(502);
    });

    it('relaxes a forced tool_choice so the loop can terminate', async () => {
      await enableSearch();
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          makeJsonResponse({ results: [] }),
        ) as unknown as typeof fetch,
      );
      let call = 0;
      const callUpstream = vi.fn<LoopCall>(async () => {
        call += 1;

        return call === 1
          ? makeJsonResponse({
              choices: [
                {
                  finish_reason: 'tool_calls',
                  message: {
                    tool_calls: [
                      {
                        id: 'c1',
                        function: {
                          arguments: '{"query":"x"}',
                          name: 'web_search',
                        },
                      },
                    ],
                  },
                },
              ],
            })
          : makeJsonResponse({
              choices: [
                { finish_reason: 'stop', message: { content: 'done' } },
              ],
            });
      });

      await executeWebSearchLoop({
        body: {
          messages: [{ content: 'hi', role: 'user' }],
          tool_choice: { function: { name: 'web_search' }, type: 'function' },
          tools: [{ type: 'web_search_preview' }],
        },
        callUpstream,
      });

      const secondCall = callUpstream.mock.calls[1]?.[0] as ChatRequestBody;
      expect(secondCall.tool_choice).toBe('auto');
    });

    it('recognises a plain function tool named web_search', async () => {
      await enableSearch();
      const callUpstream = vi.fn<LoopCall>(async () =>
        makeJsonResponse({
          choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
        }),
      );

      const result = await executeWebSearchLoop({
        body: {
          messages: [{ content: 'hi', role: 'user' }],
          tools: [{ type: 'function', function: { name: 'web_search' } }],
        },
        callUpstream,
      });

      expect(result).not.toBeNull();
    });

    it('ignores non-object tool declarations', async () => {
      await enableSearch();
      const callUpstream = vi.fn<LoopCall>(async () =>
        makeJsonResponse({
          choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
        }),
      );

      const result = await executeWebSearchLoop({
        body: {
          messages: [{ content: 'hi', role: 'user' }],
          tools: ['web_search_preview'],
        },
        callUpstream,
      });

      // A string tool cannot be a search declaration, so the loop stands down.
      expect(result).toBeNull();
      expect(callUpstream).not.toHaveBeenCalled();
    });

    it('accepts a tool that only names web_search without a type', async () => {
      await enableSearch();
      const callUpstream = vi.fn<LoopCall>(async () =>
        makeJsonResponse({
          choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
        }),
      );

      const result = await executeWebSearchLoop({
        body: {
          messages: [{ content: 'hi', role: 'user' }],
          tools: [{ name: 'web_search_preview' }],
        },
        callUpstream,
      });

      expect(result).not.toBeNull();
    });

    it('handles a search call with no arguments', async () => {
      await enableSearch();
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          makeJsonResponse({ results: [] }),
        ) as unknown as typeof fetch,
      );
      let call = 0;
      const callUpstream = vi.fn<LoopCall>(async () => {
        call += 1;

        return call === 1
          ? makeJsonResponse({
              choices: [
                {
                  finish_reason: 'tool_calls',
                  message: {
                    tool_calls: [{ function: { name: 'web_search' } }],
                  },
                },
              ],
            })
          : makeJsonResponse({
              choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
            });
      });

      const result = await executeWebSearchLoop({
        body: {
          messages: [{ content: 'hi', role: 'user' }],
          tools: [{ type: 'web_search_preview' }],
        },
        callUpstream,
      });

      const toolMessage = (
        (callUpstream.mock.calls[1]?.[0] as ChatRequestBody).messages ?? []
      )
        .filter((message) => message.role === 'tool')
        .at(-1) as { content?: unknown };
      expect(String(toolMessage.content)).toContain('without a query');
      expect(result?.response?.ok).toBe(true);
    });

    it('falls back to raw argument text when JSON is malformed', async () => {
      await enableSearch();
      const fetchMock = vi.fn(async () => makeJsonResponse({ results: [] }));
      vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
      let call = 0;
      const callUpstream = vi.fn<LoopCall>(async () => {
        call += 1;

        return call === 1
          ? makeJsonResponse({
              choices: [
                {
                  finish_reason: 'tool_calls',
                  message: {
                    tool_calls: [
                      {
                        id: 'c1',
                        function: { arguments: 'not json', name: 'web_search' },
                      },
                    ],
                  },
                },
              ],
            })
          : makeJsonResponse({
              choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
            });
      });

      await executeWebSearchLoop({
        body: {
          messages: [{ content: 'hi', role: 'user' }],
          tools: [{ type: 'web_search_preview' }],
        },
        callUpstream,
      });

      const [url] = fetchMock.mock.calls[0] as unknown as [string];
      expect(url).toContain('q=not+json');
    });

    it('keeps the first usage when a later iteration omits it', async () => {
      await enableSearch();
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          makeJsonResponse({ results: [] }),
        ) as unknown as typeof fetch,
      );
      let call = 0;
      const callUpstream = vi.fn<LoopCall>(async () => {
        call += 1;

        return call === 1
          ? makeJsonResponse({
              choices: [
                {
                  finish_reason: 'tool_calls',
                  message: {
                    tool_calls: [
                      {
                        id: 'c1',
                        function: {
                          arguments: '{"query":"x"}',
                          name: 'web_search',
                        },
                      },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 4, total_tokens: 9 },
            })
          : makeJsonResponse({
              choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
            });
      });

      const result = await executeWebSearchLoop({
        body: {
          messages: [{ content: 'hi', role: 'user' }],
          tools: [{ type: 'web_search_preview' }],
        },
        callUpstream,
      });

      const payload = (await readPayload(result)) as {
        usage: { prompt_tokens?: number };
      };
      expect(payload.usage.prompt_tokens).toBe(4);
    });

    it('adopts usage when the first iteration reports none', async () => {
      await enableSearch();
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          makeJsonResponse({ results: [] }),
        ) as unknown as typeof fetch,
      );
      let call = 0;
      const callUpstream = vi.fn<LoopCall>(async () => {
        call += 1;

        return call === 1
          ? makeJsonResponse({
              choices: [
                {
                  finish_reason: 'tool_calls',
                  message: {
                    tool_calls: [
                      {
                        id: 'c1',
                        function: {
                          arguments: '{"query":"x"}',
                          name: 'web_search',
                        },
                      },
                    ],
                  },
                },
              ],
            })
          : makeJsonResponse({
              choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
              usage: { prompt_tokens: 3, total_tokens: 6 },
            });
      });

      const result = await executeWebSearchLoop({
        body: {
          messages: [{ content: 'hi', role: 'user' }],
          tools: [{ type: 'web_search_preview' }],
        },
        callUpstream,
      });

      const payload = (await readPayload(result)) as {
        usage: { prompt_tokens?: number };
      };
      expect(payload.usage.prompt_tokens).toBe(3);
    });

    it('sums usage across loop iterations', async () => {
      await enableSearch();
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          makeJsonResponse({ results: [] }),
        ) as unknown as typeof fetch,
      );
      let call = 0;
      const callUpstream = vi.fn<LoopCall>(async () => {
        call += 1;

        return call === 1
          ? makeJsonResponse({
              choices: [
                {
                  finish_reason: 'tool_calls',
                  message: {
                    tool_calls: [
                      {
                        id: 'c1',
                        function: {
                          arguments: '{"query":"x"}',
                          name: 'web_search',
                        },
                      },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 10, total_tokens: 20 },
            })
          : makeJsonResponse({
              choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
              usage: { prompt_tokens: 5, total_tokens: 8 },
            });
      });

      const result = await executeWebSearchLoop({
        body: {
          messages: [{ content: 'hi', role: 'user' }],
          tools: [{ type: 'web_search_preview' }],
        },
        callUpstream,
      });

      const payload = (await readPayload(result)) as {
        usage: { prompt_tokens?: number; total_tokens?: number };
      };
      expect(payload.usage.prompt_tokens).toBe(15);
      expect(payload.usage.total_tokens).toBe(28);
    });

    it('returns the error when the final call without search tools fails', async () => {
      await enableSearch();
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          makeJsonResponse({ results: [] }),
        ) as unknown as typeof fetch,
      );
      const callUpstream = vi.fn<LoopCall>(async (body) => {
        const hasSearchTool = (
          (body.tools ?? []) as Array<{
            function?: { name?: string };
          }>
        ).some((tool) => tool.function?.name === 'web_search');

        return hasSearchTool
          ? makeJsonResponse({
              choices: [
                {
                  finish_reason: 'tool_calls',
                  message: {
                    tool_calls: [
                      {
                        id: 'c1',
                        function: {
                          arguments: '{"query":"x"}',
                          name: 'web_search',
                        },
                      },
                    ],
                  },
                },
              ],
            })
          : makeJsonResponse({ error: { message: 'late failure' } }, 500);
      });

      const result = await executeWebSearchLoop({
        body: {
          messages: [{ content: 'hi', role: 'user' }],
          tools: [{ type: 'web_search_preview' }],
        },
        callUpstream,
      });

      expect(result?.response?.status).toBe(500);
    });
  });

  describe('stream synthesis', () => {
    it('emits role, content, finish, and usage events', async () => {
      const response = synthesizeChatCompletionStream(
        {
          choices: [
            {
              finish_reason: 'stop',
              message: { content: 'Hello there', role: 'assistant' },
            },
          ],
          created: 42,
          id: 'chatcmpl_test',
          model: 'glm-5.1',
          usage: { total_tokens: 7 },
        },
        'fallback-model',
      );

      expect(response.headers.get('content-type')).toContain(
        'text/event-stream',
      );

      const events = await readSseEvents(response);
      expect(events.at(-1)).toBe('[DONE]');

      const parsed = events
        .filter((event) => event !== '[DONE]')
        .map((event) => JSON.parse(event) as Record<string, unknown>);

      expect(parsed[0]).toMatchObject({
        choices: [{ delta: { role: 'assistant' } }],
        id: 'chatcmpl_test',
        model: 'glm-5.1',
        object: 'chat.completion.chunk',
      });
      expect(JSON.stringify(parsed)).toContain('Hello there');
      expect(JSON.stringify(parsed.at(-2))).toContain('"finish_reason":"stop"');
      expect(JSON.stringify(parsed.at(-1))).toContain('"total_tokens":7');
    });

    it('chunks long content across multiple deltas', async () => {
      const response = synthesizeChatCompletionStream(
        {
          choices: [
            {
              finish_reason: 'stop',
              message: { content: 'x'.repeat(2500), role: 'assistant' },
            },
          ],
        },
        'fallback-model',
      );

      const events = await readSseEvents(response);
      const contentEvents = events.filter((event) =>
        event.includes('"content":"x'),
      );

      expect(contentEvents.length).toBeGreaterThan(1);
    });

    it('emits reasoning content and passes through tool calls', async () => {
      const response = synthesizeChatCompletionStream(
        {
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                content: null,
                reasoning_content: 'Let me check.',
                tool_calls: [
                  {
                    function: { arguments: '{}', name: 'read_file' },
                    type: 'function',
                  },
                ],
              },
            },
          ],
        },
        'fallback-model',
      );

      const events = await readSseEvents(response);
      const parsed = events
        .filter((event) => event !== '[DONE]')
        .map((event) => JSON.parse(event) as Record<string, unknown>);

      expect(JSON.stringify(parsed)).toContain('Let me check.');
      expect(JSON.stringify(parsed)).toContain('read_file');
      expect(JSON.stringify(parsed.at(-1))).toContain(
        '"finish_reason":"tool_calls"',
      );
    });

    it('omits a usage event when the payload has none', async () => {
      const response = synthesizeChatCompletionStream(
        { choices: [{ finish_reason: 'stop', message: { content: 'hi' } }] },
        'fallback-model',
      );

      const events = await readSseEvents(response);

      expect(JSON.stringify(events)).not.toContain('"usage"');
      expect(events.at(-1)).toBe('[DONE]');
    });

    it('injects an id and type for tool calls that omit them', async () => {
      const response = synthesizeChatCompletionStream(
        {
          choices: [
            {
              finish_reason: null,
              message: {
                content: '',
                tool_calls: [{ function: { arguments: '{}', name: 'go' } }],
              },
            },
          ],
        },
        'fallback-model',
      );

      const events = await readSseEvents(response);
      const parsed = events
        .filter((event) => event !== '[DONE]')
        .map((event) => JSON.parse(event) as Record<string, unknown>);
      const toolEvent = JSON.parse(
        events.find((event) => event.includes('"tool_calls"')) ?? '{}',
      ) as {
        choices: Array<{
          delta: { tool_calls: Array<Record<string, unknown>> };
        }>;
      };
      const toolCall = toolEvent.choices[0]?.delta.tool_calls?.[0];

      expect(toolCall?.id).toMatch(/^call_/);
      expect(toolCall?.type).toBe('function');
      expect(toolCall?.index).toBe(0);
      // No text was produced, so no content delta is emitted. With no usage
      // block the finish event is the last one before [DONE].
      expect(JSON.stringify(parsed)).not.toContain('"content":""');
      expect(JSON.stringify(parsed.at(-1))).toContain(
        '"finish_reason":"tool_calls"',
      );
    });

    it('skips reasoning when only the reasoning field is set', async () => {
      const response = synthesizeChatCompletionStream(
        {
          choices: [
            {
              finish_reason: 'stop',
              message: { content: 'hi', reasoning: 'step one' },
            },
          ],
        },
        'fallback-model',
      );

      const events = await readSseEvents(response);

      expect(JSON.stringify(events)).toContain('step one');
    });

    it('falls back to the provided model and a generated id', async () => {
      const response = synthesizeChatCompletionStream(
        { choices: [{ finish_reason: 'stop', message: { content: 'hi' } }] },
        'fallback-model',
      );

      const events = await readSseEvents(response);
      const first = JSON.parse(events[0] ?? '{}') as Record<string, unknown>;

      expect(first.model).toBe('fallback-model');
      expect(String(first.id)).toMatch(/^chatcmpl_/);
    });
  });

  describe('upstream streaming contract', () => {
    const enableSearxngSearch = async (): Promise<void> => {
      process.env.SEARXNG_URL = 'https://searx.test';
      resetWebSearchProviders();
      await updateSettings({ CODEBUDDY_WEB_SEARCH_BACKEND: 'searxng' });
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
        makeJsonResponse({
          results: [
            {
              content: 'Search result',
              title: 'Result',
              url: 'https://result.test',
            },
          ],
        }),
      );
    };

    const inlineBody = (): ChatRequestBody => ({
      messages: [{ content: 'Search', role: 'user' }],
      stream: true,
      tools: [{ type: 'web_search_preview' }],
    });

    it('hands a client call from a buffered iteration back to the client', async () => {
      await enableSearxngSearch();
      let call = 0;
      const upstream = vi.fn<LoopCall>(async () => {
        call += 1;

        if (call === 1) {
          return makeSseResponse({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      function: {
                        arguments: '{"query":"mixed"}',
                        name: 'web_search',
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
                index: 0,
              },
            ],
          });
        }

        // A buffered iteration can mix a server tool with a client-owned one:
        // the server tool runs here, the client's is handed back unanswered.
        return makeJsonResponse({
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                content: 'Checking both.',
                tool_calls: [
                  {
                    function: {
                      arguments: '{"query":"second"}',
                      name: 'web_search',
                    },
                  },
                  {
                    id: 'call_client',
                    function: { arguments: '{}', name: 'client_tool' },
                    type: 'function',
                  },
                ],
              },
            },
          ],
        });
      });

      const result = await executeWebSearchLoop({
        body: inlineBody(),
        callbacks: { emitStreamEvents: true },
        callUpstream: upstream,
      });
      const text = await result!.response!.text();

      expect(text).toContain('Checking both.');
      expect(text).toContain('client_tool');
      expect(text).toContain('"finish_reason":"tool_calls"');
    });

    it('ends the turn when a follow-up iteration stops calling server tools', async () => {
      await enableSearxngSearch();
      let call = 0;
      const upstream = vi.fn<LoopCall>(async () => {
        call += 1;

        if (call === 1) {
          return makeSseResponse({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      id: 'call_search',
                      index: 0,
                      function: {
                        arguments: '{"query":"only hop"}',
                        name: 'web_search',
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
                index: 0,
              },
            ],
          });
        }

        // No server tool this time: the held frames are forwarded untouched
        // and the turn is over.
        return makeSseResponse(
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      id: 'call_client',
                      index: 0,
                      function: { arguments: '{}', name: 'client_tool' },
                      type: 'function',
                    },
                  ],
                },
                index: 0,
              },
            ],
          },
          { choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }] },
        );
      });

      const result = await executeWebSearchLoop({
        body: inlineBody(),
        callbacks: { emitStreamEvents: true },
        callUpstream: upstream,
      });
      const text = await result!.response!.text();

      expect(text).toContain('client_tool');
      expect(text).toContain('"finish_reason":"tool_calls"');
      expect(upstream).toHaveBeenCalledTimes(2);
    });

    it('keeps malformed frames and returns mixed client tool calls', async () => {
      await enableSearxngSearch();
      const upstream = vi.fn<LoopCall>(async () => {
        const toolChunk = {
          choices: [
            {
              delta: {
                content: 'Searching.',
                reasoning_content: 'Need current data.',
                tool_calls: [
                  {
                    function: {
                      arguments: '{"query":"mixed tools"}',
                      name: 'web_search',
                    },
                  },
                  {
                    id: 'call_client',
                    index: 1,
                    function: {
                      arguments: '{"city":"Shenzhen"}',
                      name: 'get_weather',
                    },
                    type: 'function',
                  },
                ],
              },
              finish_reason: 'tool_calls',
              index: 0,
            },
          ],
          created: 123,
          id: 'chatcmpl_mixed',
          model: 'hy4-dev',
          object: 'chat.completion.chunk',
        };

        return new Response(
          `event: ping\n\ndata:\n\ndata: ${JSON.stringify(toolChunk)}\n\ndata: [DONE]`,
          { headers: { 'Content-Type': 'text/event-stream' } },
        );
      });

      const result = await executeWebSearchLoop({
        body: inlineBody(),
        callbacks: { emitStreamEvents: true },
        callUpstream: upstream,
      });
      const text = await result!.response!.text();

      expect(text).toContain('event: ping');
      expect(text).toContain('Need current data.');
      expect(text).toContain('server_tool_0_0');
      expect(text).toContain('Search result');
      expect(text).toContain('get_weather');
      expect(text).toContain('data: [DONE]');
      expect(upstream).toHaveBeenCalledTimes(1);
    });

    it('aggregates usage when the turn after a streamed tool call completes', async () => {
      await enableSearxngSearch();
      let call = 0;
      const upstream = vi.fn<LoopCall>(async () => {
        call += 1;

        if (call === 1) {
          return makeSseResponse(
            {
              choices: [
                {
                  delta: {
                    reasoning_content: 'Need usage data.',
                    tool_calls: [
                      { index: 0, function: { name: 'web_search' } },
                    ],
                  },
                  index: 0,
                },
              ],
            },
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        id: 'call_usage',
                        index: 0,
                        function: { arguments: '{"query":"usage"}' },
                      },
                    ],
                  },
                  index: 0,
                },
              ],
              usage: {
                completion_tokens: 1,
                prompt_tokens: 2,
                total_tokens: 3,
              },
            },
            {
              choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }],
            },
          );
        }

        return makeJsonResponse({
          choices: [
            { finish_reason: 'stop', message: { content: 'Final answer.' } },
          ],
          usage: { completion_tokens: 4, prompt_tokens: 5, total_tokens: 9 },
        });
      });

      const result = await executeWebSearchLoop({
        body: inlineBody(),
        callbacks: { emitStreamEvents: true },
        callUpstream: upstream,
      });
      const events = await readSseEvents(result!.response!);
      const usageEvent = events
        .map((event) => (event === '[DONE]' ? null : JSON.parse(event)))
        .find((event) => event?.usage);

      expect(usageEvent?.usage).toEqual({
        completion_tokens: 5,
        prompt_tokens: 7,
        total_tokens: 12,
      });
      expect(JSON.stringify(events)).toContain('Final answer.');
      expect(JSON.stringify(events)).toContain('call_usage');
      expect(upstream).toHaveBeenCalledTimes(2);
    });

    it('returns a later upstream error inside the composite stream', async () => {
      await enableSearxngSearch();
      let call = 0;
      const upstream = vi.fn<LoopCall>(async () => {
        call += 1;

        return call === 1
          ? makeSseResponse({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        id: 'call_search',
                        index: 0,
                        function: {
                          arguments: '{"query":"error"}',
                          name: 'web_search',
                        },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                  index: 0,
                },
              ],
            })
          : makeJsonResponse({ error: { message: 'follow-up failed' } }, 502);
      });

      const result = await executeWebSearchLoop({
        body: inlineBody(),
        callbacks: { emitStreamEvents: true },
        callUpstream: upstream,
      });

      await expect(result!.response!.text()).resolves.toContain(
        'follow-up failed',
      );
    });

    it('synthesizes an error for an empty later upstream failure', async () => {
      await enableSearxngSearch();
      let call = 0;
      const upstream = vi.fn<LoopCall>(async () => {
        call += 1;

        return call === 1
          ? makeSseResponse({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        id: 'call_search',
                        index: 0,
                        function: {
                          arguments: '{"query":"error"}',
                          name: 'web_search',
                        },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                  index: 0,
                },
              ],
            })
          : new Response(null, { status: 502 });
      });

      const result = await executeWebSearchLoop({
        body: inlineBody(),
        callbacks: { emitStreamEvents: true },
        callUpstream: upstream,
      });

      await expect(result!.response!.text()).resolves.toContain(
        'Upstream request failed with status 502',
      );
    });

    it('rejects invalid JSON from a successful later upstream response', async () => {
      await enableSearxngSearch();
      let call = 0;
      const upstream = vi.fn<LoopCall>(async () => {
        call += 1;

        return call === 1
          ? makeSseResponse({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        id: 'call_search',
                        index: 0,
                        function: {
                          arguments: '{"query":"invalid follow-up"}',
                          name: 'web_search',
                        },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                  index: 0,
                },
              ],
            })
          : new Response('not json', { status: 200 });
      });

      const result = await executeWebSearchLoop({
        body: inlineBody(),
        callbacks: { emitStreamEvents: true },
        callUpstream: upstream,
      });

      await expect(result!.response!.text()).rejects.toThrow();
    });

    it('returns later mixed client calls after executing another server tool', async () => {
      await enableSearxngSearch();
      let call = 0;
      const upstream = vi.fn<LoopCall>(async () => {
        call += 1;

        if (call === 1) {
          return makeSseResponse({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      id: 'call_first',
                      index: 0,
                      function: {
                        arguments: '{"query":"first"}',
                        name: 'web_search',
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
                index: 0,
              },
            ],
          });
        }

        return makeJsonResponse({
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                content: 'Use both results.',
                tool_calls: [
                  {
                    function: {
                      arguments: '{"query":"second"}',
                      name: 'web_search',
                    },
                  },
                  {
                    id: 'call_client',
                    function: {
                      arguments: '{}',
                      name: 'client_tool',
                    },
                    type: 'function',
                  },
                ],
              },
            },
          ],
        });
      });

      const result = await executeWebSearchLoop({
        body: inlineBody(),
        callbacks: { emitStreamEvents: true },
        callUpstream: upstream,
      });
      const text = await result!.response!.text();

      expect(text).toContain('server_tool_1_0');
      expect(text).toContain('client_tool');
      expect(text).toContain('Search result');
      expect(upstream).toHaveBeenCalledTimes(2);
    });

    it('drops local tools after the inline iteration budget is exhausted', async () => {
      await enableSearxngSearch();
      let call = 0;
      const upstream = vi.fn<LoopCall>(async (body) => {
        call += 1;

        if (call === 1) {
          return makeSseResponse({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      function: {
                        arguments: '{"query":"loop 0"}',
                        name: 'web_search',
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
                index: 0,
              },
            ],
          });
        }

        if (body.tools?.length) {
          return makeJsonResponse({
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  tool_calls: [
                    {
                      function: {
                        arguments: `{"query":"loop ${call - 1}"}`,
                        name: 'web_search',
                      },
                    },
                  ],
                },
              },
            ],
            usage: { total_tokens: 1 },
          });
        }

        return makeJsonResponse({
          choices: [
            { finish_reason: 'stop', message: { content: 'Budget answer.' } },
          ],
          usage: { total_tokens: 2 },
        });
      });
      const body = inlineBody();
      body.tool_choice = { function: { name: 'web_search' }, type: 'function' };

      const result = await executeWebSearchLoop({
        body,
        callbacks: { emitStreamEvents: true },
        callUpstream: upstream,
      });
      const text = await result!.response!.text();
      const finalBody = upstream.mock.calls.at(-1)?.[0];

      expect(text).toContain('Budget answer.');
      expect(finalBody?.tools).toEqual([]);
      expect(upstream).toHaveBeenCalledTimes(6);
    });

    it('streams the budget fallback answer once local tools are dropped', async () => {
      await enableSearxngSearch();
      let call = 0;
      const upstream = vi.fn<LoopCall>(async (body) => {
        call += 1;

        if (call === 1) {
          return makeSseResponse({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      function: {
                        arguments: '{"query":"loop 0"}',
                        name: 'web_search',
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
                index: 0,
              },
            ],
          });
        }

        if (body.tools?.length) {
          return makeJsonResponse({
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  tool_calls: [
                    {
                      function: {
                        arguments: `{"query":"loop ${call - 1}"}`,
                        name: 'web_search',
                      },
                    },
                  ],
                },
              },
            ],
          });
        }

        // The budget is spent and every server tool is gone, so this answer
        // ends the turn. It is streamed, so it must reach the client as-is
        // rather than being buffered into a payload.
        return makeSseResponse({
          choices: [{ delta: { content: 'Budget stream.' }, index: 0 }],
        });
      });

      const result = await executeWebSearchLoop({
        body: inlineBody(),
        callbacks: { emitStreamEvents: true },
        callUpstream: upstream,
      });
      const text = await result!.response!.text();
      const finalBody = upstream.mock.calls.at(-1)?.[0];

      expect(text).toContain('Budget stream.');
      expect(finalBody?.tools).toEqual([]);
      expect(upstream).toHaveBeenCalledTimes(6);
    });

    it('uses a JSON budget fallback answer when upstream does not stream', async () => {
      await enableSearxngSearch();
      let call = 0;
      const upstream = vi.fn<LoopCall>(async (body) => {
        call += 1;

        if (call === 1) {
          return makeSseResponse({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      function: {
                        arguments: '{"query":"loop 0"}',
                        name: 'web_search',
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
                index: 0,
              },
            ],
          });
        }

        if (body.tools?.length) {
          return makeJsonResponse({
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  tool_calls: [
                    {
                      function: {
                        arguments: `{"query":"loop ${call - 1}"}`,
                        name: 'web_search',
                      },
                    },
                  ],
                },
              },
            ],
            usage: { total_tokens: 1 },
          });
        }

        // A non-streaming upstream still has to produce a usable answer once
        // the budget is spent.
        return makeJsonResponse({
          choices: [
            { finish_reason: 'stop', message: { content: 'JSON fallback.' } },
          ],
          usage: { total_tokens: 4 },
        });
      });

      const result = await executeWebSearchLoop({
        body: inlineBody(),
        callbacks: { emitStreamEvents: true },
        callUpstream: upstream,
      });
      const text = await result!.response!.text();

      expect(text).toContain('JSON fallback.');
      // Usage accumulates across every iteration of the loop.
      expect(text).toContain('"total_tokens":8');
      expect(upstream).toHaveBeenCalledTimes(6);
    });

    it('hands a client tool call from the budget fallback back to the client', async () => {
      await enableSearxngSearch();
      let call = 0;
      const upstream = vi.fn<LoopCall>(async (body) => {
        call += 1;

        if (call === 1) {
          return makeSseResponse({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      function: {
                        arguments: '{"query":"loop 0"}',
                        name: 'web_search',
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
                index: 0,
              },
            ],
          });
        }

        if (body.tools?.length) {
          return makeJsonResponse({
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  tool_calls: [
                    {
                      function: {
                        arguments: `{"query":"loop ${call - 1}"}`,
                        name: 'web_search',
                      },
                    },
                  ],
                },
              },
            ],
          });
        }

        // Every server tool was stripped, so a tool call here can only be the
        // client's own: it has to be handed back rather than executed.
        return makeSseResponse({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    id: 'call_client',
                    index: 0,
                    function: { arguments: '{}', name: 'client_tool' },
                    type: 'function',
                  },
                ],
              },
              finish_reason: 'tool_calls',
              index: 0,
            },
          ],
        });
      });

      const result = await executeWebSearchLoop({
        body: inlineBody(),
        callbacks: { emitStreamEvents: true },
        callUpstream: upstream,
      });
      const text = await result!.response!.text();

      expect(text).toContain('client_tool');
      expect(text).toContain('"finish_reason":"tool_calls"');
      expect(upstream).toHaveBeenCalledTimes(6);
    });

    it('stops the budget fallback when the client disconnects', async () => {
      await enableSearxngSearch();
      const encoder = new TextEncoder();
      let call = 0;
      let resolveCancel: (() => void) | undefined;
      let upstreamCancelled: Promise<boolean> | undefined;

      const upstream = vi.fn<LoopCall>(async (body) => {
        call += 1;

        if (call === 1) {
          return makeSseResponse({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      function: {
                        arguments: '{"query":"loop 0"}',
                        name: 'web_search',
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
                index: 0,
              },
            ],
          });
        }

        if (body.tools?.length) {
          return makeJsonResponse({
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  tool_calls: [
                    {
                      function: {
                        arguments: `{"query":"loop ${call - 1}"}`,
                        name: 'web_search',
                      },
                    },
                  ],
                },
              },
            ],
          });
        }

        // The fallback answer never finishes, so only a client-side
        // cancellation can end this turn.
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    choices: [{ delta: { content: 'Fallback.' }, index: 0 }],
                  })}\n\n`,
                ),
              );
              upstreamCancelled = new Promise<boolean>((resolve) => {
                resolveCancel = () => resolve(true);
              });
            },
            cancel: () => {
              resolveCancel?.();
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } },
        );
      });

      const result = await executeWebSearchLoop({
        body: inlineBody(),
        callbacks: { emitStreamEvents: true },
        callUpstream: upstream,
      });
      const reader = result!.response!.body!.getReader();
      const decoder = new TextDecoder();
      let seen = '';

      while (!seen.includes('Fallback.')) {
        const chunk = await reader.read();
        expect(chunk.done).toBe(false);
        seen += decoder.decode(chunk.value);
      }

      await reader.cancel();

      // The disconnect has to reach the parked upstream read, not just the
      // downstream stream: a stalled upstream would otherwise stay alive.
      await expect(upstreamCancelled).resolves.toBe(true);
      expect(upstream).toHaveBeenCalledTimes(6);
    });

    it('returns an error when the final budget fallback fails upstream', async () => {
      await enableSearxngSearch();
      let call = 0;
      const upstream = vi.fn<LoopCall>(async (body) => {
        call += 1;

        if (call === 1) {
          return makeSseResponse({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      id: 'call_initial',
                      index: 0,
                      function: {
                        arguments: '{"query":"fallback error"}',
                        name: 'web_search',
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
                index: 0,
              },
            ],
          });
        }

        if (body.tools?.length) {
          return makeJsonResponse({
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  tool_calls: [
                    {
                      id: `call_${call}`,
                      function: {
                        arguments: '{"query":"again"}',
                        name: 'web_search',
                      },
                    },
                  ],
                },
              },
            ],
          });
        }

        return makeJsonResponse({ error: { message: 'fallback failed' } }, 502);
      });

      const result = await executeWebSearchLoop({
        body: inlineBody(),
        callbacks: { emitStreamEvents: true },
        callUpstream: upstream,
      });

      await expect(result!.response!.text()).resolves.toContain(
        'fallback failed',
      );
      expect(upstream).toHaveBeenCalledTimes(6);
    });

    it('leaves an empty non-SSE initial response untouched', async () => {
      await enableSearxngSearch();
      const response = new Response(null, { status: 204 });

      const result = await executeWebSearchLoop({
        body: inlineBody(),
        callbacks: { emitStreamEvents: true },
        callUpstream: async () => response,
      });

      expect(result?.response).toBe(response);
      await expect(result!.response!.text()).resolves.toBe('');
    });

    it('always asks upstream to stream and buffers the response', async () => {
      process.env.SEARXNG_URL = 'https://searx.test';
      resetWebSearchProviders();
      await updateSettings({ CODEBUDDY_WEB_SEARCH_BACKEND: 'searxng' });

      const upstreamBodies: Array<Record<string, unknown>> = [];
      let call = 0;

      const fetchMock = vi.fn(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);

          if (url.includes('searx.test')) {
            return makeJsonResponse({
              results: [{ content: 'snip', title: 'T', url: 'https://t.test' }],
            });
          }

          call += 1;
          upstreamBodies.push(JSON.parse(String(init?.body ?? '{}')));

          // Upstream only ever speaks SSE.
          const chunk =
            call === 1
              ? {
                  choices: [
                    {
                      delta: {
                        tool_calls: [
                          {
                            id: 'call_1',
                            index: 0,
                            type: 'function',
                            function: {
                              arguments: '{"query":"q1"}',
                              name: 'web_search',
                            },
                          },
                        ],
                      },
                      finish_reason: 'tool_calls',
                    },
                  ],
                }
              : {
                  choices: [
                    { delta: { content: 'Done.' }, finish_reason: 'stop' },
                  ],
                };

          return new Response(
            `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,
            {
              status: 200,
              headers: {
                'Content-Type': 'text/event-stream; charset=utf-8',
              },
            },
          );
        },
      );

      vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

      const result = await executeWebSearchLoop({
        body: {
          messages: [{ content: 'hi', role: 'user' }],
          stream: false,
          tools: [{ type: 'web_search_preview' }],
        },
        callUpstream: (loopBody) =>
          proxyChatCompletions(
            new NextRequest('http://localhost/v1/chat/completions', {
              method: 'POST',
            }),
            loopBody,
            createProxyContextFromCredential({
              data: {
                bearer_token: 'stream-token',
                user_id: 'stream@example.com',
              },
              filePath: '/tmp/stream.json',
              filename: 'stream.json',
            }),
          ),
      });

      // Upstream must never receive stream:false — it answers 11101.
      expect(upstreamBodies.length).toBeGreaterThan(0);
      for (const body of upstreamBodies) {
        expect(body.stream).toBe(true);
      }

      // The buffered result is still a normal JSON completion for the loop.
      const payload = (await readPayload(result)) as {
        choices: Array<{ message: { content: string } }>;
      };
      expect(payload.choices[0]?.message.content).toBe('Done.');
    });
  });

  describe('config gating', () => {
    it('labels the backend selector in every locale', () => {
      expect(getSettingLabels('en-US').CODEBUDDY_WEB_SEARCH_BACKEND).toBe(
        'Web search backend',
      );
      expect(getSettingLabels('zh-CN').CODEBUDDY_WEB_SEARCH_BACKEND).toBe(
        'WebSearch 后端',
      );
      expect(getSettingLabels('ja-JP').CODEBUDDY_WEB_SEARCH_BACKEND).toBe(
        'Web 検索バックエンド',
      );
    });

    it('has no separate enable switch', () => {
      // `none` is the off state, so a second control could only contradict it.
      expect(getSettingLabels('en-US')).not.toHaveProperty(
        'CODEBUDDY_WEB_SEARCH_ENABLED',
      );
    });

    it('keeps the setting disabled when the backend is none', async () => {
      // No SEARXNG_URL here, so `searxng` cannot be built — but `isWebSearchEnabled`
      // only reflects the configured choice; the provider resolution is what
      // degrades it to nothing.
      await updateSettings({ CODEBUDDY_WEB_SEARCH_BACKEND: 'passthrough' });

      await expect(isWebSearchEnabled()).resolves.toBe(false);
    });

    it('degrades to no provider when the chosen backend is unconfigured', async () => {
      // `searxng` is selected but SEARXNG_URL is unset, so no provider can be
      // built and the tool is not advertised to the model.
      await updateSettings({ CODEBUDDY_WEB_SEARCH_BACKEND: 'searxng' });

      expect(
        resolveSearchProvider('searxng', async () => 'https://cb.test'),
      ).toBeNull();
    });

    it('accepts the backend values from the console', async () => {
      process.env.SEARXNG_URL = 'https://searx.test';
      resetWebSearchProviders();

      await updateSettings({ CODEBUDDY_WEB_SEARCH_BACKEND: 'searxng' });
      await expect(isWebSearchEnabled()).resolves.toBe(true);

      await updateSettings({ CODEBUDDY_WEB_SEARCH_BACKEND: 'passthrough' });
      await expect(isWebSearchEnabled()).resolves.toBe(false);

      await updateSettings({ CODEBUDDY_WEB_SEARCH_BACKEND: 'searxng' });
      await expect(isWebSearchEnabled()).resolves.toBe(true);
    });

    it('reads the setting from the environment when nothing is persisted', async () => {
      process.env.SEARXNG_URL = 'https://searx.test';
      process.env.CODEBUDDY_WEB_SEARCH_BACKEND = 'searxng';
      resetWebSearchProviders();

      await expect(isWebSearchEnabled()).resolves.toBe(true);

      delete process.env.CODEBUDDY_WEB_SEARCH_BACKEND;
    });

    it('reflects the backend choice', async () => {
      process.env.SEARXNG_URL = 'https://searx.test';
      resetWebSearchProviders();

      await updateSettings({ CODEBUDDY_WEB_SEARCH_BACKEND: 'searxng' });
      await expect(isWebSearchEnabled()).resolves.toBe(true);

      await updateSettings({ CODEBUDDY_WEB_SEARCH_BACKEND: 'passthrough' });
      await expect(isWebSearchEnabled()).resolves.toBe(false);
    });
  });
});

describe('responses tool translation', () => {
  beforeEach(() => {
    for (const name of SEARXNG_ENV_NAMES) {
      delete process.env[name];
    }
    resetWebSearchProviders();
  });

  afterEach(() => {
    for (const name of SEARXNG_ENV_NAMES) {
      delete process.env[name];
    }
    resetWebSearchProviders();
  });

  it('translates web_search_preview without requiring SearXNG', () => {
    const tools = translateResponsesToolsToChat([
      { type: 'web_search_preview' },
    ]) as Array<{ function: { name: string } }>;

    expect(tools.map((tool) => tool.function.name)).toEqual(['web_search']);
  });

  it('translates web_search_preview into a callable function when configured', () => {
    process.env.SEARXNG_URL = 'https://searx.test';
    resetWebSearchProviders();

    const tools = translateResponsesToolsToChat([
      { type: 'web_search_preview' },
      { type: 'function', name: 'read_file' },
    ]) as Array<{ function: { name: string } }>;

    expect(tools.map((tool) => tool.function.name)).toEqual([
      'web_search',
      'read_file',
    ]);
  });

  it('accepts dated Anthropic-style server tool types', () => {
    process.env.SEARXNG_URL = 'https://searx.test';
    resetWebSearchProviders();

    const tools = translateResponsesToolsToChat([
      { type: 'web_search_20260209', name: 'web_search' },
    ]) as Array<{ function: { name: string } }>;

    expect(tools.map((tool) => tool.function.name)).toEqual(['web_search']);
  });

  it('preserves search tools nested in a namespace', () => {
    process.env.SEARXNG_URL = 'https://searx.test';
    resetWebSearchProviders();

    const tools = translateResponsesToolsToChat([
      {
        type: 'namespace',
        name: 'docs',
        tools: [{ type: 'web_search_preview' }],
      },
    ]) as Array<{ function: { name: string } }>;

    expect(tools.map((tool) => tool.function.name)).toEqual(['web_search']);
  });
});

describe('chat proxy web search integration', () => {
  const repoRoot = process.cwd();
  const tempRootDir = path.join(repoRoot, '.tmp-websearch-proxy-root');
  const tempAccessKeysPath = path.join(
    tempRootDir,
    '.codebuddy_data',
    'access-keys.json',
  );

  const cleanup = (): void => {
    fs.rmSync(tempRootDir, { force: true, recursive: true, maxRetries: 5 });
  };

  const makeNextRequest = (
    url: string,
    init?: ConstructorParameters<typeof NextRequest>[1],
  ): NextRequest => new NextRequest(url, init);

  beforeEach(async () => {
    cleanup();
    resetCredentialRuntimeState();
    await resetUsageStats();
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(process, 'cwd').mockReturnValue(tempRootDir);
    fs.rmSync(tempAccessKeysPath, { force: true });
    await addCredential({
      bearer_token: 'websearch-test-token',
      first_message_role_to_system: false,
      responses_passthrough: false,
      user_id: 'websearch@example.com',
    });
    process.env.CODEBUDDY_AUTH_MODE = 'token';
    process.env.SEARXNG_URL = 'https://searx.test';
    resetWebSearchProviders();
    await updateSettings({ CODEBUDDY_WEB_SEARCH_BACKEND: 'searxng' });
  });

  afterEach(() => {
    cleanup();
    for (const name of SEARXNG_ENV_NAMES) {
      delete process.env[name];
    }
    resetWebSearchProviders();
    vi.useRealTimers();
  });

  it('serves a synthesized SSE stream when a streaming client triggers search', async () => {
    const upstreamCalls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (input: RequestInfo | URL) => {
        const url = String(input);

        if (url.includes('searx.test')) {
          return makeJsonResponse({
            results: [
              { content: 'Found it', title: 'Docs', url: 'https://docs.test' },
            ],
          }) as unknown as Response;
        }

        upstreamCalls.push(url);

        return makeJsonResponse({
          choices: [
            {
              finish_reason: 'stop',
              message: { content: 'It is sunny.', role: 'assistant' },
            },
          ],
          model: 'glm-5.1',
        }) as unknown as Response;
      },
    );

    const response = await proxyChatCompletions(
      makeNextRequest('http://localhost/v1/chat/completions', {
        method: 'POST',
      }),
      {
        messages: [{ role: 'user', content: 'weather today?' }],
        stream: true,
        tools: [{ type: 'web_search_20260209', name: 'web_search' }],
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const text = await response.text();
    expect(text).toContain('"content":"It is sunny."');
    expect(text).toContain('data: [DONE]');
    // The loop ran before the stream was synthesized.
    expect(upstreamCalls.length).toBeGreaterThan(0);
  });

  it('keeps ordinary replies live when server web tools are available', async () => {
    const encoder = new TextEncoder();
    let releaseFinalChunk: (() => void) | undefined;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);

      if (url.includes('searx.test')) {
        throw new Error('Search should not run for an ordinary reply');
      }

      return new Response(
        new ReadableStream<Uint8Array>({
          start: (controller) => {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  choices: [{ delta: { content: 'First chunk.' }, index: 0 }],
                })}\n\n`,
              ),
            );
            releaseFinalChunk = () => {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    choices: [
                      {
                        delta: { content: ' Final chunk.' },
                        finish_reason: 'stop',
                        index: 0,
                      },
                    ],
                  })}\n\ndata: [DONE]\n\n`,
                ),
              );
              controller.close();
            };
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } },
      );
    });

    const response = await proxyChatCompletions(
      makeNextRequest('http://localhost/v1/chat/completions', {
        method: 'POST',
      }),
      {
        messages: [{ role: 'user', content: 'say hello' }],
        stream: true,
        tools: [{ type: 'web_search_20260209', name: 'web_search' }],
      },
    );
    const reader = response.body!.getReader();
    const first = await reader.read();

    expect(new TextDecoder().decode(first.value)).toContain('First chunk.');
    expect(releaseFinalChunk).toBeTypeOf('function');

    releaseFinalChunk!();

    const remainder: string[] = [];
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      remainder.push(new TextDecoder().decode(chunk.value));
    }

    expect(remainder.join('')).toContain('Final chunk.');
    expect(remainder.join('')).toContain('data: [DONE]');
  });

  it('keeps a passthrough fetch live when search executes locally', async () => {
    await updateSettings({
      CODEBUDDY_WEB_FETCH_BACKEND: 'passthrough',
      CODEBUDDY_WEB_SEARCH_BACKEND: 'searxng',
    });
    const encoder = new TextEncoder();
    let releaseFinalChunk: (() => void) | undefined;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);

      if (url.includes('searx.test')) {
        throw new Error('Search should not run for a passthrough fetch');
      }

      return new Response(
        new ReadableStream<Uint8Array>({
          start: (controller) => {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  choices: [
                    {
                      delta: {
                        tool_calls: [
                          {
                            id: 'call_fetch',
                            index: 0,
                            function: {
                              arguments: '{"url":"https://page.test"}',
                              name: 'web_fetch',
                            },
                          },
                        ],
                      },
                      index: 0,
                    },
                  ],
                })}\n\n`,
              ),
            );
            releaseFinalChunk = () => {
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
            };
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } },
      );
    });

    const response = await proxyChatCompletions(
      makeNextRequest('http://localhost/v1/chat/completions', {
        method: 'POST',
      }),
      {
        messages: [{ role: 'user', content: 'read the page' }],
        stream: true,
        tools: [
          { type: 'web_search_20260209', name: 'web_search' },
          { type: 'web_fetch_20250910', name: 'web_fetch' },
        ],
      },
    );
    const reader = response.body!.getReader();
    const first = await reader.read();

    expect(new TextDecoder().decode(first.value)).toContain('web_fetch');
    expect(releaseFinalChunk).toBeTypeOf('function');
    releaseFinalChunk!();
    await reader.cancel();
  });

  it('replays ignorable SSE frames before ordinary content', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        [
          ': keepalive\n\n',
          'data: \n\n',
          'data: {invalid\n\n',
          `data: ${JSON.stringify({})}\n\n`,
          `data: ${JSON.stringify({
            choices: [{ delta: { tool_calls: [{ function: {} }] } }],
          })}\n\n`,
          `data: ${JSON.stringify({
            choices: [{ delta: { content: 'Ordinary answer.' }, index: 0 }],
          })}\n\n`,
          'data: [DONE]\n\n',
        ].join(''),
        { headers: { 'Content-Type': 'text/event-stream' } },
      ),
    );

    const response = await proxyChatCompletions(
      makeNextRequest('http://localhost/v1/chat/completions', {
        method: 'POST',
      }),
      {
        messages: [{ role: 'user', content: 'Say hello' }],
        stream: true,
        tools: [{ type: 'web_search_20260209', name: 'web_search' }],
      },
    );

    expect(await response.text()).toContain('Ordinary answer.');
  });

  it('passes through a stream that ends before meaningful content', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('data: [DONE]\n\n', {
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );

    const response = await proxyChatCompletions(
      makeNextRequest('http://localhost/v1/chat/completions', {
        method: 'POST',
      }),
      {
        messages: [{ role: 'user', content: 'Say nothing' }],
        stream: true,
        tools: [{ type: 'web_search_20260209', name: 'web_search' }],
      },
    );

    expect(await response.text()).toContain('data: [DONE]');
  });

  it.each([
    ['id', { id: 'call_search' }],
    ['position', {}],
  ])('detects fragmented local tool names keyed by %s', async (_label, key) => {
    let upstreamCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);

      if (url.includes('searx.test')) {
        return makeJsonResponse({ results: [] });
      }

      upstreamCalls++;
      return upstreamCalls === 1
        ? makeSseResponse(
            {
              choices: [
                {
                  delta: {
                    tool_calls: [{ ...key, function: { name: 'web_' } }],
                  },
                  finish_reason: null,
                  index: 0,
                },
              ],
            },
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        ...key,
                        function: {
                          arguments: '{"query":"fragments"}',
                          name: 'search',
                        },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                  index: 0,
                },
              ],
            },
          )
        : makeJsonResponse({
            choices: [
              { finish_reason: 'stop', message: { content: 'Found.' } },
            ],
          });
    });

    const response = await proxyChatCompletions(
      makeNextRequest('http://localhost/v1/chat/completions', {
        method: 'POST',
      }),
      {
        messages: [{ role: 'user', content: 'Search fragments' }],
        stream: true,
        tools: [{ type: 'web_search_20260209', name: 'web_search' }],
      },
    );

    expect(await response.text()).toContain('Found.');
    expect(upstreamCalls).toBe(2);
  });

  it('preserves an upstream SSE response without a body', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, {
        headers: { 'Content-Type': 'text/event-stream' },
        status: 204,
      }),
    );

    const response = await proxyChatCompletions(
      makeNextRequest('http://localhost/v1/chat/completions', {
        method: 'POST',
      }),
      {
        messages: [{ role: 'user', content: 'No body' }],
        stream: true,
        tools: [{ type: 'web_search_20260209', name: 'web_search' }],
      },
    );

    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });

  it('propagates an upstream failure after replay starts', async () => {
    const encoder = new TextEncoder();
    let failStream: (() => void) | undefined;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start: (controller) => {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  choices: [{ delta: { content: 'Partial.' }, index: 0 }],
                })}\n\n`,
              ),
            );
            failStream = () => controller.error(new Error('stream failed'));
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      ),
    );

    const response = await proxyChatCompletions(
      makeNextRequest('http://localhost/v1/chat/completions', {
        method: 'POST',
      }),
      {
        messages: [{ role: 'user', content: 'Fail later' }],
        stream: true,
        tools: [{ type: 'web_search_20260209', name: 'web_search' }],
      },
    );

    expect(failStream).toBeTypeOf('function');
    failStream!();
    await expect(response.text()).rejects.toThrow('stream failed');
  });

  it('emits Responses web_search_call lifecycle before the final message', async () => {
    delete process.env.SEARXNG_URL;
    resetWebSearchProviders();
    await updateSettings({ CODEBUDDY_WEB_SEARCH_BACKEND: 'codebuddy' });
    let upstreamCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);

      if (url.includes('/agenttool/v1/search')) {
        return makeJsonResponse({
          results: [
            {
              content: 'Current result',
              title: 'News',
              url: 'https://news.test',
            },
          ],
        });
      }

      upstreamCalls++;
      if (upstreamCalls === 1) {
        return makeSseResponse(
          {
            choices: [
              {
                delta: { reasoning_content: 'I need current information.' },
                finish_reason: null,
                index: 0,
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      id: 'call_search',
                      index: 0,
                      function: { name: 'web_' },
                    },
                  ],
                },
                finish_reason: null,
                index: 0,
              },
            ],
          },
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      function: {
                        arguments: '{"query":"latest news"}',
                        name: 'search',
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
                index: 0,
              },
            ],
          },
        );
      }

      return makeJsonResponse({
        choices: [
          { finish_reason: 'stop', message: { content: 'Latest answer.' } },
        ],
      });
    });

    const response = await handleResponsesRequest(
      makeNextRequest('http://localhost/v1/responses', { method: 'POST' }),
      {
        input: 'What is new?',
        instructions: 'Use current sources.',
        stream: true,
        tools: [{ type: 'web_search_preview' }],
      },
    );
    const text = await response.text();
    const events = text
      .split('\n\n')
      .flatMap((frame) =>
        frame
          .split('\n')
          .filter((line) => line.startsWith('data: '))
          .map((line) => line.slice(6)),
      )
      .filter((payload) => payload !== '[DONE]')
      .map((payload) => JSON.parse(payload) as Record<string, unknown>);
    const addedItems = events.filter(
      (event) => event.type === 'response.output_item.added',
    ) as Array<{
      item: { type: string };
      output_index: number;
    }>;
    const completed = events.find(
      (event) => event.type === 'response.completed',
    ) as {
      response: { output: Array<{ type: string }> };
    };

    expect(text).toContain('"type":"web_search_call"');
    expect(text).toContain('"type":"response.web_search_call.in_progress"');
    expect(text).toContain('"type":"response.web_search_call.searching"');
    expect(text).toContain('"type":"response.web_search_call.completed"');
    expect(text).toContain('"action":{"type":"search","query":"latest news"}');
    expect(text).not.toContain(
      '"type":"function_call","call_id":"call_search"',
    );
    expect(text.indexOf('"type":"web_search_call"')).toBeLessThan(
      text.indexOf('Latest answer.'),
    );
    expect(new Set(addedItems.map((event) => event.output_index)).size).toBe(
      addedItems.length,
    );
    expect(completed.response.output.map((item) => item.type)).toEqual(
      addedItems.map((event) => event.item.type),
    );
  });

  it('streams a Responses open_page lifecycle for local fetch', async () => {
    await updateSettings({ CODEBUDDY_WEB_FETCH_BACKEND: 'codebuddy' });
    let upstreamCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);

      if (url.includes('/agenttool/v1/webfetch')) {
        return makeJsonResponse({ content: 'Fetched stream.' });
      }

      if (url.includes('stream.test')) {
        throw new Error('The endpoint result should win the local fallback');
      }

      upstreamCalls++;
      return upstreamCalls === 1
        ? makeSseResponse(
            {
              choices: [
                {
                  delta: { reasoning_content: 'I need to read the page.' },
                  finish_reason: null,
                  index: 0,
                },
              ],
            },
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        function: {
                          arguments: '{"url":"https://stream.test/page"}',
                          name: 'webfetch',
                        },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                  index: 0,
                },
              ],
            },
          )
        : makeJsonResponse({
            choices: [
              { finish_reason: 'stop', message: { content: 'Fetched.' } },
            ],
          });
    });

    const response = await handleResponsesRequest(
      makeNextRequest('http://localhost/v1/responses', { method: 'POST' }),
      {
        input: 'Fetch the page',
        stream: true,
        tools: [{ type: 'web_fetch_20250910', name: 'web_fetch' }],
      },
    );
    const text = await response.text();

    expect(text).toContain('response.web_search_call.in_progress');
    expect(text).toContain('response.web_search_call.completed');
    expect(text).toContain(
      '"action":{"type":"open_page","url":"https://stream.test/page"}',
    );
    expect(text).not.toContain('"type":"function_call","call_id"');
  });

  it('streams ordinary Responses output with instructions', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeSseResponse({
        choices: [
          {
            delta: { content: 'Instruction answer.' },
            finish_reason: 'stop',
            index: 0,
          },
        ],
      }),
    );

    const response = await handleResponsesRequest(
      makeNextRequest('http://localhost/v1/responses', { method: 'POST' }),
      {
        input: 'Answer normally',
        instructions: 'Be concise.',
        stream: true,
      },
    );

    expect(await response.text()).toContain('Instruction answer.');
  });

  it('streams Responses search progress before the backend finishes', async () => {
    let finishSearch: ((response: Response) => void) | undefined;
    let upstreamCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);

      if (url.includes('searx.test')) {
        return await new Promise<Response>((resolve) => {
          finishSearch = resolve;
        });
      }

      upstreamCalls++;
      return upstreamCalls === 1
        ? makeSseResponse({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      id: 'call_search',
                      index: 0,
                      function: {
                        arguments: '{"query":"live query"}',
                        name: 'web_search',
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
                index: 0,
              },
            ],
          })
        : makeJsonResponse({
            choices: [
              { finish_reason: 'stop', message: { content: 'Live answer.' } },
            ],
          });
    });

    const response = await handleResponsesRequest(
      makeNextRequest('http://localhost/v1/responses', { method: 'POST' }),
      {
        input: 'Search live',
        stream: true,
        tools: [{ type: 'web_search_preview' }],
      },
    );
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let beforeResult = '';

    while (!beforeResult.includes('response.web_search_call.searching')) {
      const chunk = await reader.read();
      expect(chunk.done).toBe(false);
      beforeResult += decoder.decode(chunk.value);
    }

    expect(finishSearch).toBeTypeOf('function');
    expect(beforeResult).not.toContain('response.web_search_call.completed');
    finishSearch!(makeJsonResponse({ results: [] }));

    let afterResult = '';
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      afterResult += decoder.decode(chunk.value);
    }

    expect(afterResult).toContain('response.web_search_call.completed');
    expect(afterResult).toContain('Live answer.');
  });

  it('streams a Responses error when local tool upstream execution fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeJsonResponse({ error: { message: 'upstream failed' } }, 502),
    );

    const response = await handleResponsesRequest(
      makeNextRequest('http://localhost/v1/responses', { method: 'POST' }),
      {
        input: 'Search live',
        stream: true,
        tools: [{ type: 'web_search_preview' }],
      },
    );
    const text = await response.text();

    expect(text).toContain('"type":"response.error"');
    expect(text).toContain('data: [DONE]');
  });

  it('terminates Responses with an error when a post-tool request fails', async () => {
    let upstreamCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);

      if (url.includes('searx.test')) {
        return makeJsonResponse({ results: [] });
      }

      upstreamCalls++;
      return upstreamCalls === 1
        ? makeSseResponse({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      id: 'call_search',
                      index: 0,
                      function: {
                        arguments: '{"query":"error after search"}',
                        name: 'web_search',
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
                index: 0,
              },
            ],
          })
        : makeJsonResponse({ error: { message: 'follow-up failed' } }, 502);
    });

    const response = await handleResponsesRequest(
      makeNextRequest('http://localhost/v1/responses', { method: 'POST' }),
      {
        input: 'Search and fail',
        stream: true,
        tools: [{ type: 'web_search_preview' }],
      },
    );
    const text = await response.text();

    expect(text).toContain('"type":"response.error"');
    // The upstream said why it failed, so its own words are passed through
    // rather than the proxy's generic failure message.
    expect(text).toContain('follow-up failed');
    expect(text).not.toContain('"type":"response.completed"');
  });

  it.each([
    ['string', 'follow-up string', 'follow-up string'],
    [
      'message-less object',
      { code: 'upstream_error' },
      // No message exists anywhere in the payload, so the raw JSON is kept:
      // it still carries `code`, which the generic fallback would have lost.
      // The quotes are escaped because the frame is JSON-encoded for SSE.
      '{\\"error\\":{\\"code\\":\\"upstream_error\\"}}',
    ],
  ])(
    'maps a %s post-tool error payload to a terminal Responses error',
    async (_label, error, expectedMessage) => {
      let upstreamCalls = 0;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = String(input);

        if (url.includes('searx.test')) {
          return makeJsonResponse({ results: [] });
        }

        upstreamCalls++;
        return upstreamCalls === 1
          ? makeSseResponse({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        id: 'call_search',
                        index: 0,
                        function: {
                          arguments: '{"query":"error payload"}',
                          name: 'web_search',
                        },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                  index: 0,
                },
              ],
            })
          : makeJsonResponse({ error });
      });

      const response = await handleResponsesRequest(
        makeNextRequest('http://localhost/v1/responses', { method: 'POST' }),
        {
          input: 'Search and report the error',
          stream: true,
          tools: [{ type: 'web_search_preview' }],
        },
      );
      const text = await response.text();

      expect(text).toContain('"type":"response.error"');
      expect(text).toContain(expectedMessage);
      expect(text).not.toContain('"type":"response.completed"');
    },
  );

  it('does not resume a Responses server-tool loop after disconnect', async () => {
    let finishSearch: ((response: Response) => void) | undefined;
    let upstreamCalls = 0;
    const cancelSpy = vi.spyOn(ReadableStream.prototype, 'cancel');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);

      if (url.includes('searx.test')) {
        return await new Promise<Response>((resolve) => {
          finishSearch = resolve;
        });
      }

      upstreamCalls++;
      if (upstreamCalls === 1) {
        return makeSseResponse({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    function: {
                      arguments: '{"query":"cancel response"}',
                      name: 'web_search',
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
              index: 0,
            },
          ],
        });
      }

      return makeJsonResponse({
        choices: [
          { finish_reason: 'stop', message: { content: 'Late answer.' } },
        ],
      });
    });

    const response = await handleResponsesRequest(
      makeNextRequest('http://localhost/v1/responses', { method: 'POST' }),
      {
        input: 'Search and disconnect',
        stream: true,
        tools: [{ type: 'web_search_preview' }],
      },
    );

    await vi.waitFor(() => expect(finishSearch).toBeTypeOf('function'));
    await response.body!.cancel();
    const callsAfterClientCancel = cancelSpy.mock.calls.length;
    expect(callsAfterClientCancel).toBeGreaterThan(0);
    finishSearch!(makeJsonResponse({ results: [] }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(upstreamCalls).toBe(1);
    expect(cancelSpy.mock.calls.length).toBe(callsAfterClientCancel);
  });

  it('drops an unexecutable Anthropic server tool but keeps a client function', async () => {
    delete process.env.SEARXNG_URL;
    resetWebSearchProviders();
    await updateSettings({ CODEBUDDY_WEB_SEARCH_BACKEND: 'searxng' });
    const upstreamBodies: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      upstreamBodies.push(
        JSON.parse(String(init?.body)) as Record<string, unknown>,
      );

      return makeJsonResponse({
        choices: [{ finish_reason: 'stop', message: { content: 'Done.' } }],
      });
    });

    await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        max_tokens: 256,
        messages: [{ role: 'user', content: 'Search' }],
        tools: [
          {
            type: 'web_search_20260209',
            name: 'web_search',
            input_schema: {},
          },
        ],
      },
    );
    await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        max_tokens: 256,
        messages: [{ role: 'user', content: 'Use my function' }],
        tools: [{ name: 'web_search', input_schema: {} }],
      },
    );

    expect(upstreamBodies[0]?.tools).toEqual([]);
    expect(upstreamBodies[1]?.tools).toEqual([
      expect.objectContaining({
        type: 'function',
        function: expect.objectContaining({ name: 'web_search' }),
      }),
    ]);
  });

  it('replays Anthropic server-tool history as paired tool messages', async () => {
    let upstreamBody: Record<string, unknown> | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      upstreamBody = JSON.parse(String(init?.body)) as Record<string, unknown>;

      return makeJsonResponse({
        choices: [
          { finish_reason: 'stop', message: { content: 'Follow-up.' } },
        ],
      });
    });
    const encryptedContent = btoa(
      JSON.stringify({
        content: 'Search snippet',
        title: 'Result title',
        url: 'https://result.test',
      }),
    );

    await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        max_tokens: 256,
        messages: [
          { role: 'user', content: 'Research this' },
          {
            role: 'assistant',
            content: [
              {
                type: 'server_tool_use',
                id: 'srv_search',
                name: 'web_search',
                input: { query: 'current topic' },
              },
              {
                type: 'web_search_tool_result',
                tool_use_id: 'srv_search',
                content: [
                  {
                    type: 'web_search_result',
                    title: 'Result title',
                    url: 'https://result.test',
                    encrypted_content: encryptedContent,
                  },
                ],
              },
              {
                type: 'server_tool_use',
                id: 'srv_fetch',
                name: 'web_fetch',
                input: { url: 'https://result.test' },
              },
              {
                type: 'web_fetch_tool_result',
                tool_use_id: 'srv_fetch',
                content: {
                  type: 'web_fetch_result',
                  url: 'https://result.test',
                  content: {
                    type: 'document',
                    source: {
                      type: 'text',
                      media_type: 'text/plain',
                      data: 'Fetched body',
                    },
                  },
                },
              },
              { type: 'text', text: 'Initial answer.' },
            ],
          },
          { role: 'user', content: 'Continue' },
        ],
      },
    );

    const messages = upstreamBody?.messages as Array<Record<string, unknown>>;
    expect(messages.slice(1, 6)).toEqual([
      expect.objectContaining({
        role: 'assistant',
        content: null,
        tool_calls: [expect.objectContaining({ id: 'srv_search' })],
      }),
      expect.objectContaining({
        role: 'tool',
        tool_call_id: 'srv_search',
        content: expect.stringContaining('Search snippet'),
      }),
      expect.objectContaining({
        role: 'assistant',
        content: null,
        tool_calls: [expect.objectContaining({ id: 'srv_fetch' })],
      }),
      expect.objectContaining({
        role: 'tool',
        tool_call_id: 'srv_fetch',
        content: expect.stringContaining('Fetched body'),
      }),
      expect.objectContaining({
        role: 'assistant',
        content: 'Initial answer.',
      }),
    ]);
    expect(JSON.stringify(messages)).not.toContain('encrypted_content');
    expect(JSON.stringify(messages)).not.toContain('server_tool_use');
  });

  it('replays partial Anthropic server-tool results without leaking opaque data', async () => {
    let upstreamBody: Record<string, unknown> | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      upstreamBody = JSON.parse(String(init?.body)) as Record<string, unknown>;

      return makeJsonResponse({
        choices: [{ finish_reason: 'stop', message: { content: 'Handled.' } }],
      });
    });

    await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        max_tokens: 256,
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'server_tool_use' },
              {
                type: 'web_search_tool_result',
                content: [
                  null,
                  {
                    url: 'https://fallback.test',
                    snippet: 'Visible snippet',
                  },
                  { title: 'Text title', text: 'Visible text' },
                  {
                    encrypted_content: btoa(
                      JSON.stringify({ content: 'Decoded only' }),
                    ),
                    title: 'Fallback title',
                    url: 'https://item.test',
                  },
                  { encrypted_content: 'not-base64' },
                ],
              },
              {
                type: 'server_tool_use',
                id: 'fetch_partial',
                name: 'web_fetch',
              },
              {
                type: 'web_fetch_tool_result',
                tool_use_id: 'fetch_partial',
                content: { url: 42, content: 'missing document' },
              },
              { type: 'text' },
            ],
          },
          { role: 'user', content: 'Continue' },
        ],
      },
    );

    const serialized = JSON.stringify(upstreamBody?.messages);
    expect(serialized).toContain('Visible snippet');
    expect(serialized).toContain('Visible text');
    expect(serialized).toContain('Decoded only');
    expect(serialized).toContain('"name":"unknown"');
    expect(serialized).not.toContain('encrypted_content');
  });

  it('returns Anthropic server tool and fetch result blocks', async () => {
    await updateSettings({ CODEBUDDY_WEB_FETCH_BACKEND: 'codebuddy' });
    let upstreamCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);

      if (url.includes('/agenttool/v1/webfetch')) {
        return makeJsonResponse({
          content: 'Fetched article body.',
        });
      }

      if (url.includes('page.test')) {
        throw new Error('The endpoint result should win the local fallback');
      }

      upstreamCalls++;
      return upstreamCalls === 1
        ? makeSseResponse(
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        function: { name: 'web_' },
                      },
                    ],
                  },
                  index: 0,
                },
              ],
            },
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        function: {
                          arguments: '{"url":"https://page.test/article"}',
                          name: 'fetch',
                        },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                  index: 0,
                },
              ],
            },
          )
        : makeJsonResponse({
            choices: [
              {
                finish_reason: 'stop',
                message: { content: 'Article summary.' },
              },
            ],
          });
    });

    const response = await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: 'Read https://page.test/article',
          },
        ],
        stream: true,
        tools: [
          { type: 'web_fetch_20250910', name: 'web_fetch', input_schema: {} },
        ],
      },
    );
    const text = await response.text();

    expect(text).toContain('"type":"server_tool_use"');
    expect(text).toContain('"name":"web_fetch"');
    expect(text).toContain('"type":"web_fetch_tool_result"');
    expect(text).toContain('"type":"web_fetch_result"');
    expect(text).toContain('"url":"https://page.test/article"');
    expect(text).toContain('Fetched article body.');
    expect(text.indexOf('"type":"server_tool_use"')).toBeLessThan(
      text.indexOf('Article summary.'),
    );
  });

  it('keeps ordinary Messages replies live when WebSearch is available', async () => {
    await updateSettings({ CODEBUDDY_WEB_SEARCH_BACKEND: 'codebuddy' });
    const encoder = new TextEncoder();
    let releaseFinalChunk: (() => void) | undefined;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      expect(String(input)).toContain('/v2/chat/completions');

      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  choices: [
                    { delta: { content: 'Live first chunk.' }, index: 0 },
                  ],
                })}\n\n`,
              ),
            );
            releaseFinalChunk = () => {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    choices: [
                      {
                        delta: { content: ' Final chunk.' },
                        finish_reason: 'stop',
                        index: 0,
                      },
                    ],
                  })}\n\ndata: [DONE]\n\n`,
                ),
              );
              controller.close();
            };
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    });

    const response = await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Say hello' }],
        stream: true,
        tools: [
          {
            description: 'Search the web',
            input_schema: { type: 'object' },
            name: 'WebSearch',
          },
        ],
      },
    );
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let firstText = '';

    while (!firstText.includes('Live first chunk.')) {
      const chunk = await reader.read();
      expect(chunk.done).toBe(false);
      firstText += decoder.decode(chunk.value);
    }

    expect(releaseFinalChunk).toBeTypeOf('function');
    releaseFinalChunk!();

    let remainder = '';
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      remainder += decoder.decode(chunk.value);
    }

    expect(remainder).toContain('Final chunk.');
  });

  it('keeps pre-tool Messages text live and executes a later CodeBuddy search', async () => {
    await updateSettings({
      CODEBUDDY_WEB_FETCH_BACKEND: 'codebuddy',
      CODEBUDDY_WEB_SEARCH_BACKEND: 'codebuddy',
    });
    const upstreamBodies: Array<Record<string, unknown>> = [];
    let searchCalls = 0;
    let upstreamCalls = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);

      if (url.includes('/agenttool/v1/search')) {
        searchCalls++;
        return makeJsonResponse({
          results: [
            {
              snippet: 'Current iOS news.',
              title: 'Latest iOS',
              url: 'https://news.test/ios',
            },
          ],
        });
      }

      upstreamCalls++;
      upstreamBodies.push(
        JSON.parse(String(init?.body)) as Record<string, unknown>,
      );

      return upstreamCalls === 1
        ? makeSseResponse(
            {
              choices: [
                {
                  delta: { content: 'I will search now.' },
                  index: 0,
                },
              ],
            },
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        id: 'call_search',
                        index: 0,
                        function: {
                          arguments: '{"query":"latest iOS news"}',
                          name: 'web_search',
                        },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                  index: 0,
                },
              ],
            },
          )
        : makeJsonResponse({
            choices: [
              {
                finish_reason: 'stop',
                message: { content: 'Here is the latest iOS news.' },
              },
            ],
          });
    });

    const response = await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Search for iOS news' }],
        stream: true,
        tools: [
          {
            description: 'Search the web',
            input_schema: {
              type: 'object',
              properties: { query: { type: 'string' } },
              required: ['query'],
            },
            name: 'WebSearch',
          },
        ],
      },
    );
    const text = await response.text();
    const firstTools = upstreamBodies[0]?.tools as Array<{
      function?: { name?: string };
    }>;
    const secondMessages = upstreamBodies[1]?.messages as Array<{
      role?: string;
      tool_call_id?: string;
    }>;

    expect(text).toContain('I will search now.');
    expect(text).toContain('"type":"server_tool_use"');
    expect(text).toContain('"type":"web_search_tool_result"');
    expect(text).toContain('Here is the latest iOS news.');
    expect(text).not.toContain('"type":"tool_use"');
    expect(firstTools[0]?.function?.name).toBe('web_search');
    expect(secondMessages).toContainEqual(
      expect.objectContaining({ role: 'tool', tool_call_id: 'call_search' }),
    );
    expect(searchCalls).toBe(1);
    expect(upstreamCalls).toBe(2);
  });

  it('keeps the text a multi-hop turn wrote between two searches', async () => {
    await updateSettings({ CODEBUDDY_WEB_SEARCH_BACKEND: 'codebuddy' });
    let upstreamCalls = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);

      if (url.includes('/agenttool/v1/search')) {
        return makeJsonResponse({
          results: [
            { snippet: 'snip', title: 'Result', url: 'https://r.test' },
          ],
        });
      }

      upstreamCalls++;

      if (upstreamCalls === 1) {
        return makeSseResponse({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    id: 'call_first',
                    index: 0,
                    function: {
                      arguments: '{"query":"first hop"}',
                      name: 'web_search',
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
              index: 0,
            },
          ],
        });
      }

      // The model speaks and reasons before searching again. That text is part
      // of the visible turn, so it must not be swallowed by the loop.
      if (upstreamCalls === 2) {
        return makeJsonResponse({
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                content: 'First hop was inconclusive.',
                reasoning_content: 'Narrowing the query.',
                tool_calls: [
                  {
                    id: 'call_second',
                    function: {
                      arguments: '{"query":"second hop"}',
                      name: 'web_search',
                    },
                  },
                ],
              },
            },
          ],
        });
      }

      return makeJsonResponse({
        choices: [
          {
            finish_reason: 'stop',
            message: { content: 'Two hops later.' },
          },
        ],
      });
    });

    const response = await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Two hop question' }],
        stream: true,
        tools: [
          {
            type: 'web_search_20260209',
            name: 'web_search',
            input_schema: {},
          },
        ],
      },
    );
    const text = await response.text();

    expect(text).toContain('First hop was inconclusive.');
    expect(text).toContain('Narrowing the query.');
    expect(text).toContain('Two hops later.');
    expect(text.indexOf('First hop was inconclusive.')).toBeLessThan(
      text.indexOf('Two hops later.'),
    );
    expect((text.match(/"type":"server_tool_use"/g) ?? []).length).toBe(2);
    expect((text.match(/"type":"web_search_tool_result"/g) ?? []).length).toBe(
      2,
    );
    // A buffered iteration is re-emitted from the payload, so it must appear
    // exactly once — not once from the payload and once from the fold.
    expect((text.match(/First hop was inconclusive\./g) ?? []).length).toBe(1);
    expect((text.match(/Narrowing the query\./g) ?? []).length).toBe(1);
    expect(upstreamCalls).toBe(3);
  });

  it('does not repeat text a streamed iteration already forwarded', async () => {
    await updateSettings({ CODEBUDDY_WEB_SEARCH_BACKEND: 'codebuddy' });
    const encoder = new TextEncoder();
    let upstreamCalls = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);

      if (url.includes('/agenttool/v1/search')) {
        return makeJsonResponse({
          results: [
            { snippet: 'snip', title: 'Result', url: 'https://r.test' },
          ],
        });
      }

      upstreamCalls++;

      if (upstreamCalls === 1) {
        return makeSseResponse({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    id: 'call_first',
                    index: 0,
                    function: {
                      arguments: '{"query":"first hop"}',
                      name: 'web_search',
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
              index: 0,
            },
          ],
        });
      }

      if (upstreamCalls === 2) {
        // A streamed iteration: its deltas are forwarded as they arrive, so
        // re-emitting the accumulated text afterwards would duplicate it.
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    choices: [
                      { delta: { content: 'Spoken between hops.' }, index: 0 },
                    ],
                  })}\n\n`,
                ),
              );
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    choices: [
                      {
                        delta: { reasoning_content: 'Thinking between hops.' },
                        index: 0,
                      },
                    ],
                  })}\n\n`,
                ),
              );
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    choices: [
                      {
                        delta: {
                          tool_calls: [
                            {
                              id: 'call_second',
                              index: 0,
                              function: {
                                arguments: '{"query":"second hop"}',
                                name: 'web_search',
                              },
                            },
                          ],
                        },
                        index: 0,
                      },
                    ],
                  })}\n\n`,
                ),
              );
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    choices: [
                      { delta: {}, finish_reason: 'tool_calls', index: 0 },
                    ],
                  })}\n\n`,
                ),
              );
              controller.close();
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } },
        );
      }

      return makeJsonResponse({
        choices: [
          { finish_reason: 'stop', message: { content: 'Two hops later.' } },
        ],
      });
    });

    const response = await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Two hop question' }],
        stream: true,
        tools: [
          {
            type: 'web_search_20260209',
            name: 'web_search',
            input_schema: {},
          },
        ],
      },
    );
    const text = await response.text();

    expect(text).toContain('Spoken between hops.');
    expect(text).toContain('Thinking between hops.');
    expect(text).toContain('Two hops later.');
    expect((text.match(/Spoken between hops\./g) ?? []).length).toBe(1);
    expect((text.match(/Thinking between hops\./g) ?? []).length).toBe(1);
    expect(upstreamCalls).toBe(3);
  });

  it('streams the final Messages answer as upstream produces it', async () => {
    await updateSettings({ CODEBUDDY_WEB_SEARCH_BACKEND: 'codebuddy' });
    const encoder = new TextEncoder();
    let upstreamCalls = 0;
    let releaseSecondChunk: (() => void) | undefined;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);

      if (url.includes('/agenttool/v1/search')) {
        return makeJsonResponse({
          results: [
            { snippet: 'snip', title: 'Result', url: 'https://r.test' },
          ],
        });
      }

      upstreamCalls++;

      if (upstreamCalls === 1) {
        return makeSseResponse({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    id: 'call_search',
                    index: 0,
                    function: {
                      arguments: '{"query":"streamed answer"}',
                      name: 'web_search',
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
              index: 0,
            },
          ],
        });
      }

      // The final answer arrives in two pieces, the second only after the test
      // releases it — so a buffered replay collapses both into one instant.
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  choices: [{ delta: { content: 'First half.' }, index: 0 }],
                })}\n\n`,
              ),
            );
            releaseSecondChunk = () => {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    choices: [
                      { delta: { content: ' Second half.' }, index: 0 },
                    ],
                  })}\n\n`,
                ),
              );
              controller.close();
            };
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    });

    const response = await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Stream the answer' }],
        stream: true,
        tools: [
          {
            type: 'web_search_20260209',
            name: 'web_search',
            input_schema: {},
          },
        ],
      },
    );

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let before = '';

    while (!before.includes('First half.')) {
      const chunk = await reader.read();
      expect(chunk.done).toBe(false);
      before += decoder.decode(chunk.value);
    }

    // The first half has to arrive before the second is even produced; a
    // buffered final iteration would withhold it until the whole answer was in.
    expect(before).not.toContain('Second half.');
    expect(releaseSecondChunk).toBeTypeOf('function');
    releaseSecondChunk!();

    let remainder = '';
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      remainder += decoder.decode(chunk.value);
    }

    expect(remainder).toContain('Second half.');
    expect(before).toContain('"type":"web_search_tool_result"');
  });

  it('streams Messages server_tool_use before the backend result', async () => {
    let finishSearch: ((response: Response) => void) | undefined;
    let upstreamCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);

      if (url.includes('searx.test')) {
        return await new Promise<Response>((resolve) => {
          finishSearch = resolve;
        });
      }

      upstreamCalls++;
      return upstreamCalls === 1
        ? makeSseResponse({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      id: 'call_search',
                      index: 0,
                      function: {
                        arguments: '{"query":"live messages"}',
                        name: 'web_search',
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
                index: 0,
              },
            ],
          })
        : makeJsonResponse({
            choices: [
              {
                finish_reason: 'stop',
                message: { content: 'Messages answer.' },
              },
            ],
          });
    });

    const response = await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Search live' }],
        stream: true,
        tools: [
          {
            type: 'web_search_20260209',
            name: 'web_search',
            input_schema: {},
          },
        ],
      },
    );
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let beforeResult = '';

    while (!beforeResult.includes('"type":"server_tool_use"')) {
      const chunk = await reader.read();
      expect(chunk.done).toBe(false);
      beforeResult += decoder.decode(chunk.value);
    }

    expect(finishSearch).toBeTypeOf('function');
    expect(beforeResult).not.toContain('"type":"web_search_tool_result"');
    finishSearch!(
      makeJsonResponse({
        results: [
          { content: 'Live result', title: 'Live', url: 'https://live.test' },
        ],
      }),
    );

    let afterResult = '';
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      afterResult += decoder.decode(chunk.value);
    }

    expect(afterResult).toContain('"type":"web_search_tool_result"');
    expect(afterResult).toContain('Messages answer.');
  });

  it('streams a Messages error when local tool upstream execution fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeJsonResponse({ error: { message: 'upstream failed' } }, 502),
    );

    const response = await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Search live' }],
        stream: true,
        tools: [
          {
            type: 'web_search_20260209',
            name: 'web_search',
            input_schema: {},
          },
        ],
      },
    );

    expect(await response.text()).toContain('"type":"error"');
  });

  it.each([
    [
      'an empty body',
      new Response(null, { status: 502 }),
      'Upstream CodeBuddy request failed',
    ],
    ['a JSON string detail', makeJsonResponse({ detail: '123' }, 502), '123'],
  ])(
    'maps %s from a non-streaming Messages failure',
    async (_label, failure, message) => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(failure);

      const response = await handleMessagesRequest(
        makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
        {
          max_tokens: 1024,
          messages: [{ role: 'user', content: 'Fail normally' }],
        },
      );
      const payload = (await response.json()) as {
        error: { message: string };
      };

      expect(response.status).toBe(502);
      expect(payload.error.message).toBe(message);
    },
  );

  it('stops the follow-up iteration when the client disconnects mid-answer', async () => {
    await updateSettings({ CODEBUDDY_WEB_SEARCH_BACKEND: 'codebuddy' });
    const encoder = new TextEncoder();
    let upstreamCalls = 0;
    let resolveCancel: (() => void) | undefined;
    let upstreamCancelled: Promise<boolean> | undefined;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);

      if (url.includes('/agenttool/v1/search')) {
        return makeJsonResponse({
          results: [
            { snippet: 'snip', title: 'Result', url: 'https://r.test' },
          ],
        });
      }

      upstreamCalls++;

      if (upstreamCalls === 1) {
        return makeSseResponse({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    id: 'call_search',
                    index: 0,
                    function: {
                      arguments: '{"query":"cancel mid answer"}',
                      name: 'web_search',
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
              index: 0,
            },
          ],
        });
      }

      // The answer never finishes on its own, so only a cancellation can end
      // this iteration.
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  choices: [{ delta: { content: 'Partial.' }, index: 0 }],
                })}\n\n`,
              ),
            );
            upstreamCancelled = new Promise<boolean>((resolve) => {
              resolveCancel = () => resolve(true);
            });
          },
          cancel: () => {
            resolveCancel?.();
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    });

    const response = await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Cancel mid answer' }],
        stream: true,
        tools: [
          {
            type: 'web_search_20260209',
            name: 'web_search',
            input_schema: {},
          },
        ],
      },
    );

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let seen = '';

    while (!seen.includes('Partial.')) {
      const chunk = await reader.read();
      expect(chunk.done).toBe(false);
      seen += decoder.decode(chunk.value);
    }

    await reader.cancel();

    // The disconnect must reach the parked upstream read, not only the
    // downstream stream, so a stalled upstream does not stay alive.
    await expect(upstreamCancelled).resolves.toBe(true);
    expect(upstreamCalls).toBe(2);
  });

  it('cancels a late Messages upstream stream after disconnect', async () => {
    let finishSearch: ((response: Response) => void) | undefined;
    let upstreamCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);

      if (url.includes('searx.test')) {
        return await new Promise<Response>((resolve) => {
          finishSearch = resolve;
        });
      }

      upstreamCalls++;
      if (upstreamCalls === 1) {
        return makeSseResponse({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    function: {
                      arguments: '{"query":"cancel messages"}',
                      name: 'web_search',
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
              index: 0,
            },
          ],
        });
      }

      return makeJsonResponse({
        choices: [
          { finish_reason: 'stop', message: { content: 'Late answer.' } },
        ],
      });
    });

    const response = await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Search and disconnect' }],
        stream: true,
        tools: [
          {
            type: 'web_search_20260209',
            name: 'web_search',
            input_schema: {},
          },
        ],
      },
    );

    await vi.waitFor(() => expect(finishSearch).toBeTypeOf('function'));
    await response.body!.cancel();
    finishSearch!(makeJsonResponse({ results: [] }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(upstreamCalls).toBe(1);
  });

  it('folds multi-hop text into a non-streaming Messages answer', async () => {
    await updateSettings({ CODEBUDDY_WEB_SEARCH_BACKEND: 'codebuddy' });
    let upstreamCalls = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);

      if (url.includes('/agenttool/v1/search')) {
        return makeJsonResponse({
          results: [
            { snippet: 'snip', title: 'Result', url: 'https://r.test' },
          ],
        });
      }

      upstreamCalls++;

      if (upstreamCalls === 1) {
        return makeJsonResponse({
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                tool_calls: [
                  {
                    id: 'call_first',
                    function: {
                      arguments: '{"query":"first hop"}',
                      name: 'web_search',
                    },
                  },
                ],
              },
            },
          ],
        });
      }

      if (upstreamCalls === 2) {
        return makeJsonResponse({
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                content: 'First hop was inconclusive.',
                reasoning_content: 'Narrowing the query.',
                tool_calls: [
                  {
                    id: 'call_second',
                    function: {
                      arguments: '{"query":"second hop"}',
                      name: 'web_search',
                    },
                  },
                ],
              },
            },
          ],
        });
      }

      return makeJsonResponse({
        choices: [
          { finish_reason: 'stop', message: { content: 'Two hops later.' } },
        ],
      });
    });

    const response = await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Two hop question' }],
        tools: [
          {
            type: 'web_search_20260209',
            name: 'web_search',
            input_schema: {},
          },
        ],
      },
    );
    const payload = (await response.json()) as {
      content: Array<{ text?: string; thinking?: string; type: string }>;
    };
    const text = payload.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('');
    const thinking = payload.content
      .filter((block) => block.type === 'thinking')
      .map((block) => block.thinking ?? '')
      .join('');

    // A non-streaming turn has no place to emit intermediate deltas, so the
    // text is folded in ahead of the final answer rather than dropped.
    expect(text).toContain('First hop was inconclusive.');
    expect(text).toContain('Two hops later.');
    expect(text.indexOf('First hop was inconclusive.')).toBeLessThan(
      text.indexOf('Two hops later.'),
    );
    expect(thinking).toContain('Narrowing the query.');
    expect(upstreamCalls).toBe(3);
  });

  it('does not repeat the current text in a non-streaming mixed turn', async () => {
    await updateSettings({ CODEBUDDY_WEB_SEARCH_BACKEND: 'codebuddy' });
    let upstreamCalls = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);

      if (url.includes('/agenttool/v1/search')) {
        return makeJsonResponse({
          results: [
            { snippet: 'snip', title: 'Result', url: 'https://r.test' },
          ],
        });
      }

      upstreamCalls++;

      if (upstreamCalls === 1) {
        return makeJsonResponse({
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                tool_calls: [
                  {
                    id: 'call_first',
                    function: {
                      arguments: '{"query":"first hop"}',
                      name: 'web_search',
                    },
                  },
                ],
              },
            },
          ],
        });
      }

      // A turn that carries its own text, asks for another search, and also
      // calls a client-owned tool: the mixed payload already includes the
      // current text, so folding it in again would duplicate it.
      return makeJsonResponse({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: 'Checking both.',
              reasoning_content: 'Weighing the results.',
              tool_calls: [
                {
                  id: 'call_second',
                  function: {
                    arguments: '{"query":"second hop"}',
                    name: 'web_search',
                  },
                },
                {
                  id: 'call_client',
                  function: { arguments: '{}', name: 'client_tool' },
                  type: 'function',
                },
              ],
            },
          },
        ],
      });
    });

    const response = await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Mixed turn' }],
        tools: [
          {
            type: 'web_search_20260209',
            name: 'web_search',
            input_schema: {},
          },
        ],
      },
    );
    const payload = (await response.json()) as {
      content: Array<{ text?: string; thinking?: string; type: string }>;
    };
    const serialized = JSON.stringify(payload);

    expect((serialized.match(/Checking both\./g) ?? []).length).toBe(1);
    expect((serialized.match(/Weighing the results\./g) ?? []).length).toBe(1);
    expect(upstreamCalls).toBe(2);
  });

  it('maps a completed fetch to a Responses open_page call', async () => {
    await updateSettings({ CODEBUDDY_WEB_FETCH_BACKEND: 'codebuddy' });
    let upstreamCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);

      if (url.includes('/agenttool/v1/webfetch')) {
        return makeJsonResponse({
          content: 'Fetched documentation.',
        });
      }

      if (url.includes('docs.test')) {
        throw new Error('The endpoint result should win the local fallback');
      }

      upstreamCalls++;
      return upstreamCalls === 1
        ? makeJsonResponse({
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  tool_calls: [
                    {
                      id: 'call_fetch',
                      function: {
                        arguments: '{"url":"https://docs.test/start"}',
                        name: 'web_fetch',
                      },
                    },
                  ],
                },
              },
            ],
          })
        : makeJsonResponse({
            choices: [
              { finish_reason: 'stop', message: { content: 'Documentation.' } },
            ],
          });
    });

    const response = await handleResponsesRequest(
      makeNextRequest('http://localhost/v1/responses', { method: 'POST' }),
      {
        input: 'Read https://docs.test/start',
        tools: [{ type: 'web_fetch_20250910', name: 'web_fetch' }],
      },
    );
    const payload = (await response.json()) as {
      output: Array<Record<string, unknown>>;
    };

    expect(payload.output[0]).toMatchObject({
      type: 'web_search_call',
      status: 'completed',
      action: { type: 'open_page', url: 'https://docs.test/start' },
    });
    expect(payload.output[1]).toMatchObject({ type: 'message' });
  });

  it('includes completed search blocks in a non-streaming Messages response', async () => {
    let upstreamCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);

      if (url.includes('searx.test')) {
        return makeJsonResponse({
          results: [
            {
              content: 'Search snippet',
            },
          ],
        });
      }

      upstreamCalls++;
      return upstreamCalls === 1
        ? makeJsonResponse({
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  tool_calls: [
                    {
                      id: 'call_search',
                      function: {
                        arguments: '{"query":"current status"}',
                        name: 'web_search',
                      },
                    },
                  ],
                },
              },
            ],
          })
        : makeJsonResponse({
            choices: [
              {
                finish_reason: 'stop',
                message: { content: 'Current answer.' },
              },
            ],
          });
    });

    const response = await handleMessagesRequest(
      makeNextRequest('http://localhost/v1/messages', { method: 'POST' }),
      {
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'What is current?' }],
        tools: [
          {
            type: 'web_search_20260209',
            name: 'web_search',
            input_schema: {},
          },
        ],
      },
    );
    const payload = (await response.json()) as {
      content: Array<Record<string, unknown>>;
      usage: Record<string, unknown>;
    };

    expect(payload.content[0]).toMatchObject({
      type: 'server_tool_use',
      name: 'web_search',
      input: { query: 'current status' },
    });
    expect(payload.content[1]).toMatchObject({
      type: 'web_search_tool_result',
      content: [
        {
          type: 'web_search_result',
          title: '',
          url: '',
        },
      ],
    });
    expect(payload.content[2]).toMatchObject({
      type: 'text',
      text: 'Current answer.',
    });
    expect(payload.usage.server_tool_use).toEqual({
      web_search_requests: 1,
      web_fetch_requests: 0,
    });
  });
});

describe('proxy integration', () => {
  const tempRootDir = path.join(
    process.cwd(),
    '.tmp-test-websearch-proxy-root',
  );
  const tempDataDir = path.join(tempRootDir, '.codebuddy_data');

  const makeProxyRequest = () =>
    new NextRequest('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer test-token' },
    });

  beforeEach(async () => {
    for (const name of SEARXNG_ENV_NAMES) {
      delete process.env[name];
    }
    resetWebSearchProviders();
    resetCredentialRuntimeState();
    cleanupDir();
    fs.mkdirSync(tempDataDir, { recursive: true });
    vi.spyOn(process, 'cwd').mockReturnValue(tempRootDir);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    process.env.CODEBUDDY_AUTH_MODE = 'auto';
    await addCredential({
      bearer_token: 'websearch-proxy-token',
      responses_passthrough: false,
      user_id: 'websearch@example.com',
    });
  });

  afterEach(() => {
    for (const name of SEARXNG_ENV_NAMES) {
      delete process.env[name];
    }
    resetWebSearchProviders();
    cleanupDir();
    vi.restoreAllMocks();
  });

  const cleanupDir = (): void => {
    fs.rmSync(tempRootDir, { force: true, recursive: true, maxRetries: 5 });
  };

  it('runs a local search end to end for a non-streaming request', async () => {
    process.env.SEARXNG_URL = 'https://searx.test';
    resetWebSearchProviders();
    await updateSettings({ CODEBUDDY_WEB_SEARCH_BACKEND: 'searxng' });

    const fetchMock = vi.spyOn(globalThis, 'fetch');
    let upstreamCalls = 0;
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);

      if (url.includes('searx.test')) {
        return makeJsonResponse({
          results: [
            { content: 'A snippet', title: 'Docs', url: 'https://docs.test' },
          ],
        });
      }

      upstreamCalls += 1;

      return upstreamCalls === 1
        ? makeJsonResponse({
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  content: null,
                  role: 'assistant',
                  tool_calls: [
                    {
                      id: 'call_1',
                      type: 'function',
                      function: {
                        arguments: '{"query":"latest release"}',
                        name: 'web_search',
                      },
                    },
                  ],
                },
              },
            ],
            usage: { total_tokens: 30 },
          })
        : makeJsonResponse({
            choices: [
              {
                finish_reason: 'stop',
                message: { content: 'It shipped yesterday.' },
              },
            ],
            usage: { total_tokens: 40 },
          });
    });

    const response = await proxyChatCompletions(makeProxyRequest(), {
      messages: [{ role: 'user', content: 'when did it ship?' }],
      tools: [{ type: 'web_search_20260209', name: 'web_search' }],
    });

    expect(response.ok).toBe(true);
    const payload = (await response.json()) as {
      choices: Array<{ message: { content: string | null } }>;
      usage?: { total_tokens?: number };
    };
    expect(payload.choices[0]?.message.content).toBe('It shipped yesterday.');
    // Usage from both iterations is summed.
    expect(payload.usage?.total_tokens).toBe(70);
    expect(upstreamCalls).toBe(2);
  });

  it('serves a synthesized stream when a search request asks to stream', async () => {
    process.env.SEARXNG_URL = 'https://searx.test';
    resetWebSearchProviders();
    await updateSettings({ CODEBUDDY_WEB_SEARCH_BACKEND: 'searxng' });

    const fetchMock = vi.spyOn(globalThis, 'fetch');
    let upstreamCalls = 0;
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);

      if (url.includes('searx.test')) {
        return makeJsonResponse({ results: [] });
      }

      upstreamCalls += 1;

      return upstreamCalls === 1
        ? makeSseResponse({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      id: 'call_1',
                      index: 0,
                      function: {
                        arguments: '{"query":"weather"}',
                        name: 'web_search',
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
                index: 0,
              },
            ],
          })
        : makeJsonResponse({
            choices: [
              { finish_reason: 'stop', message: { content: 'Sunny today.' } },
            ],
          });
    });

    const response = await proxyChatCompletions(makeProxyRequest(), {
      messages: [{ role: 'user', content: 'weather?' }],
      stream: true,
      tools: [{ type: 'web_search_preview' }],
    });

    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const text = await response.text();
    expect(text).toContain('Sunny today.');
    expect(text).toContain('data: [DONE]');
  });

  it('passes through untouched when no search tool is declared', async () => {
    process.env.SEARXNG_URL = 'https://searx.test';
    resetWebSearchProviders();
    await updateSettings({ CODEBUDDY_WEB_SEARCH_BACKEND: 'searxng' });

    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockImplementation(async () =>
      makeJsonResponse({
        choices: [{ finish_reason: 'stop', message: { content: 'plain' } }],
      }),
    );

    const response = await proxyChatCompletions(makeProxyRequest(), {
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(response.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns the upstream failure when the search request errors', async () => {
    process.env.SEARXNG_URL = 'https://searx.test';
    resetWebSearchProviders();
    await updateSettings({ CODEBUDDY_WEB_SEARCH_BACKEND: 'searxng' });

    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockImplementation(async () =>
      makeJsonResponse({ error: { message: 'upstream down' } }, 502),
    );

    const response = await proxyChatCompletions(makeProxyRequest(), {
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ type: 'web_search_preview' }],
    });

    expect(response.status).toBe(502);
  });
});
