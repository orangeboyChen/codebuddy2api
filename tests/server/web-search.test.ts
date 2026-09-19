import fs from 'node:fs';
import path from 'node:path';

import { NextRequest } from 'next/server';

import { updateSettings } from '@/lib/server/domain/config';
import {
  resetWebSearchProviders,
  resolveSearchProvider,
  runWebSearch,
} from '@/lib/server/search';
import {
  createSearxngProvider,
  createSearxngProviderFromSettings,
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
import { mapAnthropicToolsToChat } from '@/lib/server/proxy/anthropic/request';

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
    it('resolves no SearXNG provider when nothing is configured', () => {
      expect(resolveSearchProvider('searxng')).toBeNull();
    });

    it('ignores a non-absolute SearXNG address', () => {
      expect(
        resolveSearchProvider('searxng', {
          search: { searxngUrl: 'searx.example.com/search' },
        }),
      ).toBeNull();
      process.env.SEARXNG_URL = 'searx.example.com/search';
      resetWebSearchProviders();

      expect(resolveSearchProvider('searxng')).toBeNull();
    });

    it('resolves a SearXNG provider from the console setting', () => {
      process.env.SEARXNG_MAX_RESULTS = '3';

      expect(
        resolveSearchProvider('searxng', {
          search: { searxngUrl: 'https://searx.example.com/' },
        })?.id,
      ).toBe('searxng');
    });

    it('resolves a SearXNG provider from the environment as a fallback', () => {
      process.env.SEARXNG_URL = 'https://searx.example.com/';
      resetWebSearchProviders();

      expect(resolveSearchProvider('searxng')?.id).toBe('searxng');
    });

    it('reports an unconfigured backend when a query is attempted', async () => {
      await expect(runWebSearch({ query: 'hello' })).resolves.toContain(
        'no search backend is configured',
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

    it('prefers the console address over the environment', async () => {
      process.env.SEARXNG_URL = 'https://env.example.com';
      resetWebSearchProviders();
      const fetchMock = vi.fn(
        async () => makeJsonResponse({ results: [] }) as unknown as Response,
      );
      vi.stubGlobal('fetch', fetchMock);

      await resolveSearchProvider('searxng', {
        search: { searxngUrl: 'https://console.example.com' },
      })?.search('q');

      const [url] = fetchMock.mock.calls[0] as unknown as [string];
      expect(url).toContain('https://console.example.com/search?');
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

    it('returns null from the settings factory when no address is configured', () => {
      expect(createSearxngProviderFromSettings()).toBeNull();
      expect(createSearxngProviderFromSettings({ url: '  ' })).toBeNull();
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

      expect(resolveSearchProvider('searxng')?.id).toBe('searxng');
    });

    it('clamps out-of-range environment overrides', () => {
      process.env.SEARXNG_URL = 'https://searx.example.com';
      process.env.SEARXNG_MAX_RESULTS = '99';
      process.env.SEARXNG_TIMEOUT_MS = '1';
      resetWebSearchProviders();

      expect(resolveSearchProvider('searxng')?.id).toBe('searxng');
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

/**
 * §9. The declared type is the only thing that carries the server-tool /
 * client-tool distinction through translation — `normalizeToolName` makes
 * `WebSearch` and `web_search` the same string, so the name cannot. The
 * Responses translator is covered above; this is the Anthropic one, whose
 * declaration is the shape Claude Code's side request actually sends.
 */
describe('anthropic tool translation', () => {
  it('keeps a declared server tool’s type and its max_uses', () => {
    // `max_uses` is on the declaration Claude Code sends but not on
    // `AnthropicTool`, so it enters through a spread — the same way the side
    // request builds its own declaration. The translator spreads every field
    // the client declared through, so it belongs in what is asserted here.
    const translated = mapAnthropicToolsToChat([
      {
        input_schema: {},
        name: 'web_search',
        type: 'web_search_20250305',
        ...{ max_uses: 8 },
      },
    ]) as Array<Record<string, unknown>>;

    expect(translated).toHaveLength(1);
    // Downstream classification reads the type, so it has to survive — and the
    // budget rides on the declaration the client sent, not on a default.
    expect(translated[0]).toMatchObject({
      max_uses: 8,
      type: 'web_search_20250305',
    });
    // Reshaped into a function upstream can call, but still the same tool.
    expect(translated[0]).toMatchObject({ function: { name: 'web_search' } });
  });

  it('translates Claude Code’s bare WebSearch as an ordinary function', () => {
    const translated = mapAnthropicToolsToChat([
      { name: 'WebSearch', input_schema: {} },
    ]) as Array<{ type: string; function: { name: string } }>;

    // No `type` on the way in means the client resolves the call itself.
    expect(translated[0].type).toBe('function');
    expect(translated[0].function.name).toBe('WebSearch');
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

    it('withdraws a server tool that no backend can run', async () => {
      // SearXNG selected with no instance: nothing here can run the tool.
      await updateSettings({ CODEBUDDY_WEB_SEARCH_BACKEND: 'searxng' });
      clearSearxngEnv();
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

  /**
   * These go through `handleMessagesRequest`, not straight into
   * `rewriteServerTools`: the spec's phase-2 shape only ever arrives as an
   * Anthropic request, and translation is where `max_uses` and `tool_choice`
   * used to be dropped — which no unit test could see.
   */
  describe('phase 2: the side request, end to end', () => {
    /** Answers each hop from `hops`, falling through on the last. */
    const routed = (
      hops: Array<Record<string, unknown>>,
      request: Record<string, unknown>,
    ) => {
      const sent: Array<Record<string, unknown>> = [];
      let calls = 0;

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
        const url = String(_input);

        if (url.includes('searx.test')) {
          return makeJsonResponse({
            results: [
              { content: 'A snippet', title: 'Docs', url: 'https://docs.test' },
            ],
          }) as unknown as Response;
        }

        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        sent.push(body);
        const hop = hops[Math.min(calls, hops.length - 1)];
        calls += 1;

        return makeJsonResponse(hop) as unknown as Response;
      });

      return {
        calls: () => calls,
        run: () =>
          handleMessagesRequest(
            makeRequest('http://localhost/v1/messages'),
            request,
          ),
        sent,
      };
    };

    /**
     * The queries the turn actually put to the search provider, one per call.
     *
     * Read off the fetch spy rather than a counter on the hop mock: `routed`
     * answers the provider before it counts the call, so a search is invisible
     * to `calls()` — which is the point, but it means only this can prove what
     * was searched for.
     */
    const providerQueries = (): Array<string | null> =>
      vi
        .mocked(globalThis.fetch)
        .mock.calls.map(([input]) => String(input))
        .filter((url) => url.includes('searx.test'))
        .map((url) => new URL(url).searchParams.get('q'));

    const searchCall = (query: string, id: string) => ({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            content: null,
            role: 'assistant',
            tool_calls: [
              {
                id,
                type: 'function',
                function: {
                  arguments: `{"query":"${query}"}`,
                  name: 'web_search',
                },
              },
            ],
          },
        },
      ],
      usage: { completion_tokens: 10, prompt_tokens: 100 },
    });

    const answer = (text: string, reasoning?: string) => ({
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: text,
            ...(reasoning ? { reasoning_content: reasoning } : {}),
            role: 'assistant',
          },
        },
      ],
      usage: { completion_tokens: 20, prompt_tokens: 200 },
    });

    const sideRequest = (maxUses?: number) => ({
      max_tokens: 2048,
      messages: [
        {
          role: 'user' as const,
          content: 'Perform a web search for the query: OpenAI updates 2026',
        },
      ],
      tool_choice: { type: 'tool', name: 'web_search' },
      tools: [
        {
          type: 'web_search_20250305',
          name: 'web_search',
          ...(maxUses === undefined ? {} : { max_uses: maxUses }),
          input_schema: {},
        },
      ],
    });

    it('honours the forced tool_choice, then loosens it so the model may answer', async () => {
      await enableSearch();
      const { run, sent } = routed(
        [searchCall('OpenAI updates 2026', 'call_1'), answer('Here it is.')],
        sideRequest(8),
      );

      const response = await run();

      expect(sent[0]?.tool_choice).toEqual({
        type: 'function',
        function: { name: 'web_search' },
      });
      // Left pinned, the model would be forced to search forever.
      expect(sent[1]?.tool_choice).toBe('auto');
      // The server tool stays available: refusals to answer are the model's call.
      expect((sent[1]?.tools as unknown[]) ?? []).toHaveLength(1);

      const payload = (await response.json()) as {
        content: Array<{ type: string }>;
        stop_reason: string;
      };
      expect(payload.content.map((block) => block.type)).toEqual([
        'server_tool_use',
        'web_search_tool_result',
        'text',
      ]);
      expect(payload.stop_reason).toBe('end_turn');
    });

    it('streams prose written before the search, ahead of the search blocks', async () => {
      await enableSearch();
      const { run } = routed(
        [
          {
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  content: 'Let me look that up.',
                  reasoning_content: 'The user wants recent news.',
                  role: 'assistant',
                  tool_calls: [
                    {
                      id: 'call_1',
                      type: 'function',
                      function: {
                        arguments: '{"query":"OpenAI updates 2026"}',
                        name: 'web_search',
                      },
                    },
                  ],
                },
              },
            ],
            usage: { completion_tokens: 10, prompt_tokens: 100 },
          },
          answer('Here it is.'),
        ],
        { ...sideRequest(8), stream: true },
      );

      const response = await run();
      const events = await readEvents(response);
      const types = events
        .filter((event) => event.event === 'content_block_start')
        .map(
          (event) =>
            (JSON.parse(event.data) as { content_block: { type: string } })
              .content_block.type,
        );

      // What was written before the search, then the search, then the answer.
      expect(types).toEqual([
        'thinking',
        'text',
        'server_tool_use',
        'web_search_tool_result',
        'text',
      ]);
      expect(JSON.stringify(events)).toContain('Let me look that up.');
      expect(JSON.stringify(events)).toContain('Here it is.');
    });

    it('renders the answer’s own reasoning after the search blocks', async () => {
      await enableSearch();
      const { run } = routed(
        [
          {
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
                        arguments: '{"query":"OpenAI updates 2026"}',
                        name: 'web_search',
                      },
                    },
                  ],
                },
              },
            ],
            usage: { completion_tokens: 10, prompt_tokens: 100 },
          },
          answer('Here it is.', 'The results answer it.'),
        ],
        sideRequest(8),
      );

      const payload = (await run().then((r) => r.json())) as {
        content: Array<{ thinking?: string; type: string }>;
      };

      // The reasoning that produced the answer belongs after the searches it
      // followed, not alongside the one that asked for them.
      expect(payload.content.map((block) => block.type)).toEqual([
        'server_tool_use',
        'web_search_tool_result',
        'thinking',
        'text',
      ]);
      expect(payload.content[2].thinking).toBe('The results answer it.');
    });

    it('renders prose written before the search, ahead of the search blocks', async () => {
      await enableSearch();
      const { run } = routed(
        [
          {
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  content: 'Let me look that up.',
                  reasoning_content: 'The user wants recent news.',
                  role: 'assistant',
                  tool_calls: [
                    {
                      id: 'call_1',
                      type: 'function',
                      function: {
                        arguments: '{"query":"OpenAI updates 2026"}',
                        name: 'web_search',
                      },
                    },
                  ],
                },
              },
            ],
            usage: { completion_tokens: 10, prompt_tokens: 100 },
          },
          answer('Here it is.'),
        ],
        sideRequest(8),
      );

      const payload = (await run().then((r) => r.json())) as {
        content: Array<{ text?: string; thinking?: string; type: string }>;
      };

      // What was written before the search, then the search, then the answer.
      expect(payload.content.map((block) => block.type)).toEqual([
        'thinking',
        'text',
        'server_tool_use',
        'web_search_tool_result',
        'text',
      ]);
      expect(payload.content[0].thinking).toBe('The user wants recent news.');
      expect(payload.content[1].text).toBe('Let me look that up.');
      expect(payload.content[4].text).toBe('Here it is.');
    });

    /**
     * Prose written *between* two searches. It used to be dropped: a single
     * preamble can only hold the first hop's, so a turn like
     * text → search → text → search → answer lost the second passage.
     */
    it('keeps the prose written between two searches, in place', async () => {
      await enableSearch();
      let hop = 0;

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = String(input);

        if (url.includes('searx.test')) {
          return makeJsonResponse({
            results: [
              { content: 'snippet', title: 'Docs', url: 'https://docs.test' },
            ],
          }) as unknown as Response;
        }

        hop += 1;

        if (hop === 1) {
          return makeJsonResponse({
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  content: 'First, the broad picture.',
                  role: 'assistant',
                  tool_calls: [
                    {
                      id: 'c1',
                      type: 'function',
                      function: {
                        arguments: '{"query":"quantum computing"}',
                        name: 'web_search',
                      },
                    },
                  ],
                },
              },
            ],
            usage: { completion_tokens: 10, prompt_tokens: 100 },
          }) as unknown as Response;
        }

        if (hop === 2) {
          return makeJsonResponse({
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  content: 'Now the 2026 announcements.',
                  role: 'assistant',
                  tool_calls: [
                    {
                      id: 'c2',
                      type: 'function',
                      function: {
                        arguments: '{"query":"IBM quantum 2026"}',
                        name: 'web_search',
                      },
                    },
                  ],
                },
              },
            ],
            usage: { completion_tokens: 10, prompt_tokens: 100 },
          }) as unknown as Response;
        }

        return makeJsonResponse(answer('Both are covered now.'));
      });

      const payload = (await handleMessagesRequest(
        makeRequest('http://localhost/v1/messages'),
        {
          max_tokens: 2048,
          messages: [{ role: 'user', content: 'summarise quantum progress' }],
          tools: [
            {
              type: 'web_search_20250305',
              name: 'web_search',
              input_schema: {},
            },
          ],
        },
      ).then((r) => r.json())) as {
        content: Array<{ text?: string; type: string }>;
        usage: { server_tool_use: { web_search_requests: number } };
      };

      // Each passage sits immediately before the search it motivated.
      expect(payload.content.map((block) => block.type)).toEqual([
        'text',
        'server_tool_use',
        'web_search_tool_result',
        'text',
        'server_tool_use',
        'web_search_tool_result',
        'text',
      ]);
      expect(payload.content[0].text).toBe('First, the broad picture.');
      expect(payload.content[3].text).toBe('Now the 2026 announcements.');
      expect(payload.content[6].text).toBe('Both are covered now.');
      expect(payload.usage.server_tool_use.web_search_requests).toBe(2);
    });

    it('bills the whole turn, not just the answering hop', async () => {
      await enableSearch();
      const { run } = routed(
        [searchCall('OpenAI updates 2026', 'call_1'), answer('Here it is.')],
        sideRequest(8),
      );

      const response = await run();
      const payload = (await response.json()) as {
        stop_reason: string;
        usage: {
          input_tokens: number;
          output_tokens: number;
          server_tool_use: { web_search_requests: number };
        };
      };

      // 100+200 prompt and 10+20 completion, both hops.
      expect(payload.usage.input_tokens).toBe(300);
      expect(payload.usage.output_tokens).toBe(30);
      expect(payload.usage.server_tool_use.web_search_requests).toBe(1);
    });

    it('stops searching at the max_uses the client declared', async () => {
      await enableSearch();
      const { run, calls } = routed(
        [
          searchCall('one', 'call_1'),
          searchCall('two', 'call_2'),
          searchCall('three', 'call_3'),
        ],
        sideRequest(2),
      );

      const response = await run();
      const payload = (await response.json()) as {
        content: Array<{ type: string }>;
        stop_reason: string;
        usage: { server_tool_use: { web_search_requests: number } };
      };

      expect(payload.usage.server_tool_use.web_search_requests).toBe(2);
      // Two searches, then the closing call with the tool withdrawn, then stop.
      expect(calls()).toBe(3);
      // Nothing leaks: the client never declared a `web_search` function.
      expect(payload.content.map((block) => block.type)).not.toContain(
        'tool_use',
      );
      expect(payload.stop_reason).toBe('end_turn');
    });

    it('searches repeatedly and reports every search', async () => {
      await enableSearch();
      const { run, calls } = routed(
        [
          searchCall('one', 'call_1'),
          searchCall('two', 'call_2'),
          answer('Done.'),
        ],
        sideRequest(8),
      );

      const response = await run();
      const payload = (await response.json()) as {
        content: Array<{ type: string }>;
        usage: { server_tool_use: { web_search_requests: number } };
      };

      expect(calls()).toBe(3);
      expect(payload.usage.server_tool_use.web_search_requests).toBe(2);
      expect(payload.content.map((block) => block.type)).toEqual([
        'server_tool_use',
        'web_search_tool_result',
        'server_tool_use',
        'web_search_tool_result',
        'text',
      ]);
    });

    it('runs the server tool while leaving the client’s own WebSearch alone', async () => {
      await enableSearch();
      const { run } = routed(
        [searchCall('OpenAI updates 2026', 'call_1'), answer('Here it is.')],
        {
          max_tokens: 2048,
          messages: [{ role: 'user', content: 'lookup' }],
          tools: [
            {
              type: 'web_search_20250305',
              name: 'web_search',
              max_uses: 8,
              input_schema: {},
            },
            {
              name: 'WebSearch',
              description: 'Search the web',
              input_schema: { type: 'object' },
            },
          ],
        },
      );

      const response = await run();
      const payload = (await response.json()) as {
        usage: { server_tool_use: { web_search_requests: number } };
      };

      // The client declaring WebSearch used to look like a name collision and
      // switch the whole feature off.
      expect(payload.usage.server_tool_use.web_search_requests).toBe(1);
    });

    /**
     * Both declarations in one request, and the model calls both on the first
     * hop — the one request where §23-A and §23-B conflict.
     *
     * `WebSearch` and `web_search` are the same string once case and separators
     * are stripped, so only the declared type can tell them apart. Get it wrong
     * in either direction and Claude Code loses: run the client's `WebSearch`
     * here and it never receives the `tool_use` it needs (§26), or withhold the
     * server tool and the side request it is waiting on never searches.
     */
    it('runs the server tool and still hands the client’s own WebSearch back', async () => {
      await enableSearch();
      const { calls, run } = routed(
        [
          {
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  content: null,
                  role: 'assistant',
                  tool_calls: [
                    {
                      id: 'call_server',
                      type: 'function',
                      function: {
                        arguments: '{"query":"OpenAI updates 2026"}',
                        name: 'web_search',
                      },
                    },
                    {
                      id: 'call_client',
                      type: 'function',
                      function: {
                        arguments: '{"query":"OpenAI updates 2026"}',
                        name: 'WebSearch',
                      },
                    },
                  ],
                },
              },
            ],
            usage: { completion_tokens: 10, prompt_tokens: 100 },
          },
          answer('Here it is.'),
        ],
        {
          max_tokens: 2048,
          messages: [
            {
              role: 'user',
              content:
                'Perform a web search for the query: OpenAI updates 2026',
            },
          ],
          tools: [
            {
              type: 'web_search_20250305',
              name: 'web_search',
              max_uses: 8,
              input_schema: {},
            },
            {
              name: 'WebSearch',
              description: 'Search the web',
              input_schema: { type: 'object' },
            },
          ],
        },
      );

      const payload = (await run().then((r) => r.json())) as {
        content: Array<{ name?: string; type: string }>;
        stop_reason: string;
        usage: { server_tool_use: { web_search_requests: number } };
      };

      // The declared server tool really ran, against the provider.
      expect(providerQueries()).toHaveLength(1);
      expect(payload.usage.server_tool_use.web_search_requests).toBe(1);

      // ...and it is reported structurally, never as a `tool_use` — a client
      // that declared a provider-executed tool has no handler for one.
      expect(payload.content.map((block) => block.type)).toEqual([
        'server_tool_use',
        'web_search_tool_result',
        'tool_use',
      ]);
      expect(payload.content[0].name).toBe('web_search');

      // The client's own call survived, and it is the only `tool_use` here.
      expect(
        payload.content.filter((block) => block.type === 'tool_use'),
      ).toEqual([expect.objectContaining({ name: 'WebSearch' })]);
      expect(payload.stop_reason).toBe('tool_use');

      // The turn stops at this hop: continuing would replay an assistant
      // message whose client call has no result behind it.
      expect(calls()).toBe(1);
    });

    /**
     * §11 and §26: the query that reaches the provider has to be the one the
     * model emitted as its `web_search` argument, never one extracted from the
     * prompt. Every other phase-2 test uses the same string in both places, so
     * a regression that regex-scraped the prompt would pass them all.
     */
    it('searches for the query the model emitted, not the one in the prompt', async () => {
      await enableSearch();
      const { run } = routed(
        [searchCall('IBM quantum 2026', 'call_1'), answer('Here it is.')],
        sideRequest(8),
      );

      const response = await run();
      const payload = (await response.json()) as {
        content: Array<{ input?: { query?: string }; type: string }>;
        usage: { server_tool_use: { web_search_requests: number } };
      };

      const searchedQueries = providerQueries();

      // The prompt asked about OpenAI; the model chose IBM. Only the model's
      // argument may reach the provider.
      expect(searchedQueries).toEqual(['IBM quantum 2026']);
      expect(payload.usage.server_tool_use.web_search_requests).toBe(1);
      expect(payload.content[0]).toMatchObject({
        input: { query: 'IBM quantum 2026' },
        type: 'server_tool_use',
      });
    });
  });

  /**
   * Phase 3: Claude Code wraps the side-request answer as a `tool_result` for
   * its own `WebSearch` and carries on. This must not re-enter the server-tool
   * path — and it is the shape the whole flow exists to serve.
   */
  it('serves the main agent continuation without searching again', async () => {
    await enableSearch();
    let calls = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);

      if (url.includes('searx.test')) {
        throw new Error('the continuation must not search');
      }

      calls += 1;

      return makeJsonResponse({
        choices: [
          {
            finish_reason: 'stop',
            message: { content: 'OpenAI 最近主要有这些更新。' },
          },
        ],
      }) as unknown as Response;
    });

    const response = await handleMessagesRequest(
      makeRequest('http://localhost/v1/messages'),
      {
        max_tokens: 2048,
        messages: [
          { role: 'user', content: '帮我查一下 OpenAI 最近有什么更新' },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_search_001',
                name: 'WebSearch',
                input: { query: 'OpenAI latest updates 2026' },
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_search_001',
                content: '根据搜索结果，OpenAI 最近……',
              },
            ],
          },
        ],
        tools: [
          {
            name: 'WebSearch',
            description: 'Search the web',
            input_schema: { type: 'object' },
          },
          {
            name: 'Read',
            description: 'read',
            input_schema: { type: 'object' },
          },
        ],
      },
    );

    const payload = (await response.json()) as {
      content: Array<{ type: string }>;
      stop_reason: string;
    };

    expect(calls).toBe(1);
    expect(payload.content).toEqual([
      { type: 'text', text: 'OpenAI 最近主要有这些更新。' },
    ]);
    expect(payload.stop_reason).toBe('end_turn');
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

    /**
     * The preamble is the prose a model writes before it searches. It was
     * repositioned three times and had no test at all: this pins both halves —
     * that it is emitted, and that it lands *before* the searches it preceded.
     */
    it('puts a Responses preamble ahead of the searches, and streams the answer', async () => {
      await enableSearch();
      let calls = 0;

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = String(input);

        if (url.includes('searx.test')) {
          return makeJsonResponse({
            results: [
              { content: 'snippet', title: 'Docs', url: 'https://docs.test' },
            ],
          }) as unknown as Response;
        }

        calls += 1;

        return makeJsonResponse(
          calls === 1
            ? {
                choices: [
                  {
                    finish_reason: 'tool_calls',
                    message: {
                      // Speaks first, then asks — the case the preamble is for.
                      content: 'Let me look that up.',
                      reasoning_content: 'The user wants recent news.',
                      role: 'assistant',
                      tool_calls: [
                        {
                          id: 'c1',
                          type: 'function',
                          function: {
                            arguments: '{"query":"OpenAI updates"}',
                            name: 'web_search',
                          },
                        },
                      ],
                    },
                  },
                ],
              }
            : {
                choices: [
                  {
                    finish_reason: 'stop',
                    message: {
                      content: 'Here is what I found.',
                      role: 'assistant',
                    },
                  },
                ],
              },
        ) as unknown as Response;
      });

      const response = await handleResponsesRequest(
        makeRequest('http://localhost/v1/responses'),
        {
          input: 'any news on OpenAI?',
          model: 'glm-5.1',
          tools: [{ type: 'web_search_preview' }],
        },
      );

      const payload = (await response.json()) as {
        output: Array<{ content?: Array<{ text?: string }>; type: string }>;
        output_text: string;
      };

      expect(payload.output.map((item) => item.type)).toEqual([
        'reasoning',
        'message',
        'web_search_call',
        'message',
      ]);
      // The preamble, then the search, then the answer — in the order written.
      expect(payload.output[1].content?.[0]?.text).toBe('Let me look that up.');
      expect(payload.output[3].content?.[0]?.text).toBe(
        'Here is what I found.',
      );
      // Not the preamble: a delta-subscribing client must get the answer.
      expect(payload.output_text).toBe('Here is what I found.');
    });

    it('streams a Responses preamble ahead of the searches', async () => {
      await enableSearch();
      let calls = 0;

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = String(input);

        if (url.includes('searx.test')) {
          return makeJsonResponse({
            results: [
              { content: 'snippet', title: 'Docs', url: 'https://docs.test' },
            ],
          }) as unknown as Response;
        }

        calls += 1;

        return makeJsonResponse(
          calls === 1
            ? {
                choices: [
                  {
                    finish_reason: 'tool_calls',
                    message: {
                      content: 'Let me look that up.',
                      reasoning_content: 'The user wants recent news.',
                      role: 'assistant',
                      tool_calls: [
                        {
                          id: 'c1',
                          type: 'function',
                          function: {
                            arguments: '{"query":"OpenAI updates"}',
                            name: 'web_search',
                          },
                        },
                      ],
                    },
                  },
                ],
              }
            : {
                choices: [
                  {
                    finish_reason: 'stop',
                    message: {
                      content: 'Here is what I found.',
                      role: 'assistant',
                    },
                  },
                ],
              },
        ) as unknown as Response;
      });

      const response = await handleResponsesRequest(
        makeRequest('http://localhost/v1/responses'),
        {
          input: 'any news on OpenAI?',
          model: 'glm-5.1',
          stream: true,
          tools: [{ type: 'web_search_preview' }],
        },
      );

      const text = await response.text();

      // One opening, under one id.
      expect(text.match(/"type":"response\.created"/g)).toHaveLength(1);
      expect(text).toContain('Let me look that up.');
      expect(text).toContain('Here is what I found.');
      // The answer is what streams as text deltas, not the preamble.
      expect(text).toContain('"delta":"Here is what I found."');
      expect(text).toContain('"type":"response.completed"');
    });

    it('reports the upstream’s own message when a streamed turn fails', async () => {
      await enableSearch();

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = String(input);

        if (url.includes('searx.test')) {
          return makeJsonResponse({ results: [] }) as unknown as Response;
        }

        return new Response(
          JSON.stringify({ error: { message: 'rate limited upstream' } }),
          { headers: { 'Content-Type': 'application/json' }, status: 429 },
        ) as unknown as Response;
      });

      const response = await handleResponsesRequest(
        makeRequest('http://localhost/v1/responses'),
        {
          input: 'any news?',
          model: 'glm-5.1',
          stream: true,
          tools: [{ type: 'web_search_preview' }],
        },
      );

      const text = await response.text();

      // A rate limit has to arrive as one, or a client that retries on that
      // alone stops retrying.
      expect(text).toContain('rate limited upstream');
      expect(text).toContain('"type":"response.error"');
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

    /**
     * Answers each hop from `hops`, falling through on the last, and keeps
     * every request body that reached upstream.
     *
     * The Responses path is non-streaming hop to hop regardless of `stream`:
     * whether the model wants another search is only knowable once a hop has
     * finished, so the turn buffers every one.
     */
    const routed = (
      hops: Array<Record<string, unknown>>,
      request: Record<string, unknown>,
    ) => {
      const sent: Array<Record<string, unknown>> = [];
      let calls = 0;

      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
        const url = String(_input);

        if (url.includes('searx.test')) {
          return makeJsonResponse({
            results: [
              { content: 'A snippet', title: 'Docs', url: 'https://docs.test' },
            ],
          }) as unknown as Response;
        }

        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        sent.push(body);
        const hop = hops[Math.min(calls, hops.length - 1)];
        calls += 1;

        return makeJsonResponse(hop) as unknown as Response;
      });

      return {
        calls: () => calls,
        run: () =>
          handleResponsesRequest(
            makeRequest('http://localhost/v1/responses'),
            request,
          ),
        sent,
      };
    };

    const searchHop = (query: string) => ({
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
                  arguments: `{"query":"${query}"}`,
                  name: 'web_search',
                },
              },
            ],
          },
        },
      ],
      usage: { completion_tokens: 10, prompt_tokens: 100 },
    });

    const answerHop = (text: string) => ({
      choices: [
        {
          finish_reason: 'stop',
          message: { content: text, role: 'assistant' },
        },
      ],
      usage: { completion_tokens: 20, prompt_tokens: 200 },
    });

    /** A search declared and pinned by its hosted-tool type. */
    const pinned = {
      input: 'any news?',
      model: 'glm-5.1',
      tool_choice: { type: 'web_search_preview' },
      tools: [{ type: 'web_search_preview' }],
    };

    /**
     * The Responses API pins a hosted tool by its declared type, and the pin is
     * load-bearing: it is what makes the model emit a query instead of
     * answering from memory. It used to be rejected outright — 400, no search.
     */
    it('runs the search when tool_choice pins the hosted tool', async () => {
      await enableSearch();
      mockUpstream();

      const response = await handleResponsesRequest(
        makeRequest('http://localhost/v1/responses'),
        pinned,
      );

      expect(response.status).toBe(200);

      const payload = (await response.json()) as {
        output: Array<Record<string, unknown>>;
      };
      const types = payload.output.map((item) => item.type);

      expect(types).toContain('web_search_call');
      expect(types).toContain('message');
      // The pin held, so the search ran before the answer that used it.
      expect(types.indexOf('web_search_call')).toBeLessThan(
        types.indexOf('message'),
      );
    });

    it('sends the pin upstream as the function the proxy injected', async () => {
      await enableSearch();
      const { run, sent } = routed(
        [searchHop('OpenAI updates'), answerHop('Here it is.')],
        pinned,
      );

      await run();

      // Upstream has never heard of `web_search_preview`; the pin has to name
      // the function the declaration was rewritten into.
      expect(sent[0]?.tool_choice).toEqual({
        type: 'function',
        function: { name: 'web_search' },
      });
    });

    it('stops pinning the hosted tool after the first hop', async () => {
      await enableSearch();
      const { run, sent } = routed(
        [searchHop('OpenAI updates'), answerHop('Here it is.')],
        pinned,
      );

      await run();

      // Left pinned, the model would be forced to search forever instead of
      // answering with what it found.
      expect(sent[1]?.tool_choice).toBe('auto');
    });

    it('drops the pin instead of failing when no backend is configured', async () => {
      // No `enableSearch()`: `beforeEach` clears SEARXNG_URL, so nothing here
      // can run the declared tool and it is withdrawn from the request.
      const { run, sent } = routed(
        [answerHop('It shipped in March, as I recall.')],
        pinned,
      );

      const response = await run();

      expect(response.status).toBe(200);
      // A choice naming a tool the request no longer offers is a contradiction
      // upstream rejects, so it goes rather than being sent as it is.
      expect(sent[0]?.tool_choice).toBeUndefined();

      const payload = (await response.json()) as {
        output: Array<Record<string, unknown>>;
        output_text: string;
      };

      expect(payload.output.map((item) => item.type)).not.toContain(
        'web_search_call',
      );
      // Answering from memory is the honest degradation, not a 400.
      expect(payload.output_text).toBe('It shipped in March, as I recall.');
    });

    const pinnedImage = {
      input: 'draw a cat',
      model: 'glm-5.1',
      tool_choice: { type: 'image_generation' },
      tools: [{ type: 'image_generation' }],
    };

    /**
     * Image generation is executed here, by its own loop rather than the
     * server-tool turn, so a pin on it is a request this adapter can serve —
     * and it used to be rejected outright with a 400.
     */
    it('serves a request pinning the image tool by its hosted type', async () => {
      const { run, sent } = routed(
        [answerHop('Here is the cat.')],
        pinnedImage,
      );

      const response = await run();

      expect(response.status).toBe(200);
      // Upstream has never heard of `image_generation` as a tool type; the pin
      // has to name the function the declaration was rewritten into.
      expect(sent[0]?.tool_choice).toEqual({
        type: 'function',
        function: { name: 'image_generation' },
      });
    });

    /**
     * `file_search` has no implementation here, so its declaration is
     * withdrawn from what goes upstream. Pinning it is therefore not a client
     * error but a request to serve without the tool — the same degradation a
     * server tool with no backend already gets.
     */
    it('drops a pin on a hosted tool this adapter does not implement', async () => {
      const { run, sent } = routed([answerHop('From memory.')], {
        input: 'search the docs',
        model: 'glm-5.1',
        tool_choice: { type: 'file_search' },
        tools: [{ type: 'file_search' }],
      });

      const response = await run();

      expect(response.status).toBe(200);
      expect(sent[0]?.tool_choice).toBeUndefined();

      const payload = (await response.json()) as { output_text: string };

      // The request is still served — just without the tool it pinned.
      expect(payload.output_text).toBe('From memory.');
    });

    /**
     * The relaxation above is scoped to a declaration the request actually
     * made. A pin naming a tool that was never on offer is a client error, and
     * it has to stay one.
     */
    it('rejects a pin on a hosted tool the request never declared', async () => {
      const { run, sent } = routed([answerHop('From memory.')], {
        input: 'search the docs',
        model: 'glm-5.1',
        tool_choice: { type: 'file_search' },
        tools: [{ type: 'function', name: 'lookup', parameters: {} }],
      });

      const response = await run();

      expect(response.status).toBe(400);
      // Rejected before anything is sent upstream.
      expect(sent).toHaveLength(0);
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
