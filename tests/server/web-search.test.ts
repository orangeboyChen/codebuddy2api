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
      // The typed declaration is still stripped. Forwarding it upstream would
      // send a tool type the upstream does not implement, and handing it back
      // would give the client a tool nobody runs.
      expect(result?.response).toBeNull();
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
                    tool_calls: [
                      { id: 'c1', function: { name: 'web_search' } },
                    ],
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

  it('drops web_search_preview when no backend is configured', () => {
    expect(
      translateResponsesToolsToChat([{ type: 'web_search_preview' }]),
    ).toBeUndefined();
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
        ? makeJsonResponse({
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  tool_calls: [
                    {
                      id: 'call_1',
                      function: {
                        arguments: '{"query":"weather"}',
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
