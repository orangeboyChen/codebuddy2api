import fs from 'node:fs';
import path from 'node:path';

import { NextRequest } from 'next/server';

import { updateSettings } from '@/lib/server/domain/config';
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
  rewriteServerTools,
  runServerToolTurn,
} from '@/lib/server/proxy/server-tools';
import { proxyChatCompletions } from '@/lib/server/proxy/codebuddy';
import {
  addCredential,
  resetCredentialRuntimeState,
} from '@/lib/server/domain/credentials';
import { translateResponsesToolsToChat } from '@/lib/server/proxy/responses';
import { handleResponsesRequest } from '@/lib/server/proxy/responses';
import { handleMessagesRequest } from '@/lib/server/proxy/anthropic';

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

/** Upstream is always asked to stream, so the follow-up answer arrives as SSE. */
const makeSseAnswer = (content: string): Response =>
  makeSseResponse(
    {
      choices: [{ delta: { content, role: 'assistant' }, index: 0 }],
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
    },
    {
      choices: [{ delta: {}, finish_reason: 'stop', index: 0 }],
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
    },
  );

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
      const callUpstream = vi.fn(async () => {
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

      await runServerToolTurn({
        body: {
          messages: [{ content: 'hi', role: 'user' }],
          tools: [{ type: 'web_search_preview' }],
        },
        callUpstream,
        fetchProvider: null,
        rewrite: rewriteServerTools({
          declarations: { fetch: false, search: true },
          fetchProvider: null,
          searchProvider: resolveSearchProvider('searxng'),
          tools: [{ type: 'web_search_preview' }],
        })!,
        searchProvider: resolveSearchProvider('searxng'),
        stream: false,
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
      // No query can be recovered, so no request is made and the turn reports
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
});

// ---------------------------------------------------------------------------
// Route-level behaviour
//
// The corrected flow, end to end. A client declares `WebSearch` as an ordinary
// function and resolves it itself; the proxy must hand the model's call back as
// a `tool_use` block and run nothing. Only a request whose tools carry a
// provider-executed *type* — the sub-request Claude Code sends once it has a
// `WebSearch` result to fill in — runs a search here.
// ---------------------------------------------------------------------------

describe('responses tool translation', () => {
  it('keeps a provider-executed declaration’s type on the chat tool', () => {
    const translated = translateResponsesToolsToChat([
      { type: 'web_search_preview' },
    ]) as Array<{ type: string; function: { name: string } }>;

    expect(translated).toHaveLength(1);
    // Downstream classification reads the type, so it has to survive.
    expect(translated[0].type).toBe('web_search_preview');
    expect(translated[0].function.name).toBe('web_search');
  });

  it('translates a client function as an ordinary function', () => {
    const translated = translateResponsesToolsToChat([
      { type: 'function', name: 'Read', parameters: {} },
    ]) as Array<{ type: string; function: { name: string } }>;

    expect(translated[0].type).toBe('function');
    expect(translated[0].function.name).toBe('Read');
  });
});

describe('server tool routing', () => {
  const tempRootDir = path.join(process.cwd(), '.tmp-servertool-route-root');
  const tempDataDir = path.join(tempRootDir, '.codebuddy_data');

  const cleanupDir = (): void => {
    fs.rmSync(tempRootDir, { force: true, recursive: true, maxRetries: 5 });
  };

  const makeRequest = (url: string): NextRequest =>
    new NextRequest(url, {
      method: 'POST',
      headers: { authorization: 'Bearer servertool-token' },
    });

  const enableSearch = async (): Promise<void> => {
    process.env.SEARXNG_URL = 'https://searx.test';
    resetWebSearchProviders();
    await updateSettings({ CODEBUDDY_WEB_SEARCH_BACKEND: 'searxng' });
  };

  /** Upstream answers the first call with a tool call and the rest with text. */
  const mockUpstream = ({
    toolName = 'web_search',
    answer = 'It shipped yesterday.',
    arguments: args = '{"query":"latest release"}',
  } = {}): { upstreamCalls: () => number } => {
    let calls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);

      if (url.includes('searx.test')) {
        return makeJsonResponse({
          results: [
            { content: 'A snippet', title: 'Docs', url: 'https://docs.test' },
          ],
        }) as unknown as Response;
      }

      calls += 1;

      return calls === 1
        ? (makeJsonResponse({
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
                      function: { arguments: args, name: toolName },
                    },
                  ],
                },
              },
            ],
          }) as unknown as Response)
        : makeSseAnswer(answer);
    });

    return { upstreamCalls: () => calls };
  };

  const readEvents = async (
    response: Response,
  ): Promise<Array<{ data: string; event: string }>> => {
    const text = await response.text();

    return text
      .split('\n\n')
      .map((frame) => {
        const lines = frame.split('\n');
        const event = lines
          .find((line) => line.startsWith('event: '))
          ?.slice(7)
          .trim();
        const data = lines
          .filter((line) => line.startsWith('data: '))
          .map((line) => line.slice(6))
          .join('');

        return { data, event: event ?? '' };
      })
      .filter((frame) => frame.data.length > 0);
  };

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
      bearer_token: 'servertool-token',
      responses_passthrough: false,
      user_id: 'servertool@example.com',
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

  describe('/v1/messages', () => {
    /**
     * The regression, end to end. Claude Code declares `WebSearch` as an
     * ordinary function and resolves it itself, so the proxy has to hand the
     * model's call straight back. Executing it here instead is what left Claude
     * Code with an answer invented from memory and no search at all.
     */
    it('hands Claude Code’s own WebSearch call back as a tool_use block', async () => {
      await enableSearch();
      const { upstreamCalls } = mockUpstream({ toolName: 'WebSearch' });

      const response = await handleMessagesRequest(
        makeRequest('http://localhost/v1/messages'),
        {
          max_tokens: 256,
          messages: [{ role: 'user', content: 'Search for the release date' }],
          tools: [
            {
              name: 'WebSearch',
              description: 'Search the web',
              input_schema: { type: 'object' },
            },
          ],
        },
      );

      const payload = (await response.json()) as {
        content: Array<Record<string, unknown>>;
        stop_reason: string;
      };

      expect(payload.content).toEqual([
        expect.objectContaining({
          id: 'call_1',
          name: 'WebSearch',
          type: 'tool_use',
        }),
      ]);
      expect(payload.stop_reason).toBe('tool_use');
      // Nothing was executed, so upstream was asked exactly once.
      expect(upstreamCalls()).toBe(1);
    });

    it('runs the search for a declared server tool and reports it structurally', async () => {
      await enableSearch();
      const { upstreamCalls } = mockUpstream();

      const response = await handleMessagesRequest(
        makeRequest('http://localhost/v1/messages'),
        {
          max_tokens: 256,
          messages: [{ role: 'user', content: 'when did it ship?' }],
          tools: [
            {
              type: 'web_search_20250305',
              name: 'web_search',
              input_schema: {},
            },
          ],
        },
      );

      const payload = (await response.json()) as {
        content: Array<Record<string, unknown>>;
        stop_reason: string;
      };

      // Anthropic's own order: the call, its result, then the answer.
      expect(payload.content.map((block) => block.type)).toEqual([
        'server_tool_use',
        'web_search_tool_result',
        'text',
      ]);
      expect(payload.content[0]).toMatchObject({
        input: { query: 'latest release' },
        name: 'web_search',
      });
      const result = payload.content[1] as {
        content: Array<{ url: string }>;
        tool_use_id: string;
      };
      expect(result.content[0].url).toBe('https://docs.test');
      expect(result.tool_use_id).toBe(payload.content[0].id);
      expect(payload.content[2]).toEqual({
        text: 'It shipped yesterday.',
        type: 'text',
      });
      expect(payload.stop_reason).toBe('end_turn');
      expect(upstreamCalls()).toBe(2);
    });

    it('streams the server tool blocks ahead of the answer', async () => {
      await enableSearch();
      mockUpstream();

      const response = await handleMessagesRequest(
        makeRequest('http://localhost/v1/messages'),
        {
          max_tokens: 256,
          messages: [{ role: 'user', content: 'when did it ship?' }],
          stream: true,
          tools: [
            {
              type: 'web_search_20250305',
              name: 'web_search',
              input_schema: {},
            },
          ],
        },
      );

      expect(response.headers.get('content-type')).toContain(
        'text/event-stream',
      );

      const events = await readEvents(response);
      const starts = events.filter(
        (event) => event.event === 'content_block_start',
      );
      const types = starts.map(
        (event) =>
          (JSON.parse(event.data) as { content_block: { type: string } })
            .content_block.type,
      );

      expect(types).toEqual([
        'server_tool_use',
        'web_search_tool_result',
        'text',
      ]);
      expect(events[0].event).toBe('message_start');
      // The answer the results produced still reaches the client.
      expect(JSON.stringify(events)).toContain('It shipped yesterday.');
    });

    it('leaves a server tool with no backend for the client to resolve', async () => {
      // Backend is passthrough, so nothing runs here.
      await updateSettings({ CODEBUDDY_WEB_SEARCH_BACKEND: 'passthrough' });
      const { upstreamCalls } = mockUpstream();

      const response = await handleMessagesRequest(
        makeRequest('http://localhost/v1/messages'),
        {
          max_tokens: 256,
          messages: [{ role: 'user', content: 'when did it ship?' }],
          tools: [
            {
              type: 'web_search_20250305',
              name: 'web_search',
              input_schema: {},
            },
          ],
        },
      );

      const payload = (await response.json()) as {
        content: Array<Record<string, unknown>>;
      };

      expect(payload.content.map((block) => block.type)).toEqual(['tool_use']);
      expect(upstreamCalls()).toBe(1);
    });

    it('reports an upstream failure as an Anthropic error', async () => {
      await enableSearch();
      vi.spyOn(globalThis, 'fetch').mockImplementation(
        async () =>
          new Response(JSON.stringify({ error: { message: 'nope' } }), {
            headers: { 'Content-Type': 'application/json' },
            status: 429,
          }) as unknown as Response,
      );

      const response = await handleMessagesRequest(
        makeRequest('http://localhost/v1/messages'),
        {
          max_tokens: 256,
          messages: [{ role: 'user', content: 'hi' }],
          tools: [
            {
              type: 'web_search_20250305',
              name: 'web_search',
              input_schema: {},
            },
          ],
        },
      );

      expect(response.status).toBe(429);
      expect((await response.json()) as { type: string }).toMatchObject({
        type: 'error',
      });
    });
  });

  describe('/v1/responses', () => {
    it('reports the search as a web_search_call item', async () => {
      await enableSearch();
      mockUpstream();

      const response = await handleResponsesRequest(
        makeRequest('http://localhost/v1/responses'),
        {
          input: 'when did it ship?',
          model: 'glm-5.1',
          tools: [{ type: 'web_search_preview' }],
        },
      );

      const payload = (await response.json()) as {
        output: Array<Record<string, unknown>>;
      };
      const types = payload.output.map((item) => item.type);

      expect(types).toContain('web_search_call');
      expect(types).toContain('message');
      // The search ran before the answer that used it.
      expect(types.indexOf('web_search_call')).toBeLessThan(
        types.indexOf('message'),
      );
      expect(payload.output[0]).toMatchObject({
        action: { query: 'latest release', type: 'search' },
        status: 'completed',
      });
    });

    it('leaves a client function named web_search to the client', async () => {
      await enableSearch();
      const { upstreamCalls } = mockUpstream();

      const response = await handleResponsesRequest(
        makeRequest('http://localhost/v1/responses'),
        {
          input: 'read the file',
          model: 'glm-5.1',
          tools: [{ type: 'function', name: 'web_search', parameters: {} }],
        },
      );

      const payload = (await response.json()) as {
        output: Array<Record<string, unknown>>;
      };

      expect(payload.output.map((item) => item.type)).not.toContain(
        'web_search_call',
      );
      expect(upstreamCalls()).toBe(1);
    });

    it('streams the search lifecycle events', async () => {
      await enableSearch();
      mockUpstream();

      const response = await handleResponsesRequest(
        makeRequest('http://localhost/v1/responses'),
        {
          input: 'when did it ship?',
          model: 'glm-5.1',
          stream: true,
          tools: [{ type: 'web_search_preview' }],
        },
      );

      const events = await readEvents(response);
      const types = events.map((event) => event.event);

      expect(types).toContain('response.output_item.added');
      expect(types).toContain('response.web_search_call.in_progress');
      expect(types).toContain('response.web_search_call.searching');
      expect(types).toContain('response.web_search_call.completed');
      expect(types).toContain('response.output_item.done');
    });
  });

  describe('/v1/chat/completions', () => {
    /**
     * A chat client's `web_search` function is its own. There is no
     * server-tool convention in the chat protocol, so nothing here runs —
     * the call goes back for the client to resolve.
     */
    it('does not execute a client’s own web_search function', async () => {
      await enableSearch();
      const { upstreamCalls } = mockUpstream();

      const response = await proxyChatCompletions(
        makeRequest('http://localhost/v1/chat/completions'),
        {
          messages: [{ role: 'user', content: 'search for it' }],
          tools: [{ type: 'function', function: { name: 'web_search' } }],
        },
      );

      const payload = (await response.json()) as {
        choices: Array<{ message: { tool_calls?: unknown[] } }>;
      };

      expect(payload.choices[0].message.tool_calls).toHaveLength(1);
      expect(upstreamCalls()).toBe(1);
    });
  });
});
