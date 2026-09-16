import { NextRequest } from 'next/server';

import {
  getActiveConfig,
  isWebFetchEnabled,
  updateSettings,
} from '@/lib/server/domain/config';
import { createCodeBuddyFetchProvider } from '@/lib/server/search/providers/codebuddy-fetch';
import { createCodeBuddySearchProvider } from '@/lib/server/search/providers/codebuddy-search';
import { createLocalFetchProvider } from '@/lib/server/search/providers/local-fetch';
import {
  normalizeFetchBackend,
  normalizeSearchBackend,
  resetWebSearchProviders,
  resolveFetchProvider,
  resolveSearchProvider,
  runWebFetch,
  runWebSearch,
} from '@/lib/server/search';
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
import { buildWebFetchToolDefinition } from '@/lib/server/search/tool';
import { executeWebSearchLoop } from '@/lib/server/proxy/web-search-loop';
import { withCodeBuddyToken } from '@/lib/server/search/token';

const makeJsonResponse = (
  payload: Record<string, unknown>,
  status = 200,
): Response => {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
};

type FetchCall = [string, RequestInit];

const lastFetchCall = (mock: ReturnType<typeof vi.fn>): FetchCall =>
  mock.mock.calls[mock.mock.calls.length - 1] as unknown as FetchCall;

const stubFetch = (impl: (...args: unknown[]) => Promise<Response>) => {
  const mock = vi.fn(impl as never);

  vi.stubGlobal('fetch', mock as unknown as typeof fetch);

  return mock;
};

const withCredential = async (): Promise<void> => {
  await addCredential({
    bearer_token: 'cred-token',
    created_at: Math.floor(Date.now() / 1000),
    supported_models: 'glm-5.1',
    user_id: 'tester',
  });
};

describe('server tool backends', () => {
  beforeEach(async () => {
    resetWebSearchProviders();
    resetCredentialRuntimeState();
    // Settings persist in storage, so a test that enables a tool would
    // otherwise leave it on for every test that runs after it.
    await updateSettings({
      CODEBUDDY_WEB_FETCH_BACKEND: 'codebuddy',
      CODEBUDDY_WEB_FETCH_ENABLED: false,
      CODEBUDDY_WEB_SEARCH_BACKEND: 'searxng',
      CODEBUDDY_WEB_SEARCH_ENABLED: false,
    });
  });

  afterEach(async () => {
    await updateSettings({
      CODEBUDDY_WEB_FETCH_BACKEND: 'codebuddy',
      CODEBUDDY_WEB_FETCH_ENABLED: false,
      CODEBUDDY_WEB_SEARCH_BACKEND: 'searxng',
      CODEBUDDY_WEB_SEARCH_ENABLED: false,
    });
    resetWebSearchProviders();
    resetCredentialRuntimeState();
    resetUsageStats();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('backend normalization', () => {
    it.each([
      ['codebuddy', 'codebuddy'],
      [' searxng ', 'searxng'],
      ['NONE', 'none'],
    ])('accepts %s as a search backend', (input, expected) => {
      expect(normalizeSearchBackend(input)).toBe(expected);
    });

    it('falls back to the default for an unknown search backend', () => {
      expect(normalizeSearchBackend('bogus')).toBe('searxng');
      expect(normalizeSearchBackend(undefined)).toBe('searxng');
    });

    it('falls back to the default for an unknown fetch backend', () => {
      expect(normalizeFetchBackend('bogus')).toBe('none');
      expect(normalizeFetchBackend(null)).toBe('none');
    });

    it('resolves no provider when the backend is none', () => {
      expect(
        resolveSearchProvider('none', async () => 'https://cb.test'),
      ).toBeNull();
      expect(
        resolveFetchProvider('none', async () => 'https://cb.test'),
      ).toBeNull();
    });

    it('resolves the local backend without any configuration', () => {
      expect(
        resolveFetchProvider('local', async () => 'https://cb.test')?.id,
      ).toBe('local');
    });
  });

  describe('codebuddy search provider', () => {
    it('posts to the agent-tool search path with the credential', async () => {
      const mock = stubFetch(async () =>
        makeJsonResponse({
          provider: 'tencent',
          results: [
            {
              snippet: 'A snippet',
              title: 'Docs',
              url: 'https://docs.test',
            },
          ],
          total_results: 1,
        }),
      );

      const result = await createCodeBuddySearchProvider({
        resolveEndpoint: async () => 'https://cb.test/',
        resolveToken: async () => 'token-123',
      }).search('weather today');

      const [url, init] = lastFetchCall(mock);
      expect(url).toBe('https://cb.test/agenttool/v1/search');
      expect(init.method).toBe('POST');
      expect(new Headers(init.headers).get('Authorization')).toBe(
        'Bearer token-123',
      );

      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      expect(body.query).toBe('weather today');
      expect(body.type).toBe('text2text');
      expect(body.max_results).toBe(5);

      expect(result.results).toHaveLength(1);
      expect(result.content).toContain('Docs');
      expect(result.content).toContain('https://docs.test');
    });

    it('surfaces an error payload from the endpoint', async () => {
      stubFetch(async () => makeJsonResponse({ code: 15001, msg: 'quota' }));

      await expect(
        runWebSearch({
          backend: 'codebuddy',
          provider: createCodeBuddySearchProvider({
            resolveEndpoint: async () => 'https://cb.test',
            resolveToken: async () => 'token',
          }),
          query: 'hello',
        }),
      ).resolves.toContain('CodeBuddy web search error: quota');
    });

    it('reports a non-ok HTTP status', async () => {
      stubFetch(async () => makeJsonResponse({ msg: 'nope' }, 502));

      await expect(
        runWebSearch({
          provider: createCodeBuddySearchProvider({
            resolveEndpoint: async () => 'https://cb.test',
            resolveToken: async () => 'token',
          }),
          query: 'hello',
        }),
      ).resolves.toContain('CodeBuddy web search error: nope');
    });

    it('refuses to call the endpoint without a token', async () => {
      const mock = stubFetch(async () => makeJsonResponse({ results: [] }));

      await expect(
        runWebSearch({
          provider: createCodeBuddySearchProvider({
            resolveEndpoint: async () => 'https://cb.test',
            resolveToken: async () => null,
          }),
          query: 'hello',
        }),
      ).resolves.toContain('Authentication required');
      expect(mock).not.toHaveBeenCalled();
    });

    it('short-circuits an empty query without calling the endpoint', async () => {
      const mock = stubFetch(async () => makeJsonResponse({ results: [] }));

      const result = await runWebSearch({
        provider: createCodeBuddySearchProvider({
          resolveEndpoint: async () => 'https://cb.test',
          resolveToken: async () => 'token',
        }),
        query: '   ',
      });

      expect(result).toContain('without a query');
      expect(mock).not.toHaveBeenCalled();
    });
  });

  describe('codebuddy fetch provider', () => {
    it('posts the url and prompt to the webfetch path', async () => {
      const mock = stubFetch(async () =>
        makeJsonResponse({
          content: '# Title\n\nBody text',
          url: 'https://a.test',
        }),
      );

      const result = await createCodeBuddyFetchProvider({
        resolveEndpoint: async () => 'https://cb.test',
        resolveToken: async () => 'token-123',
      }).fetch({ prompt: 'the release date', url: 'https://a.test/page' });

      const [url, init] = lastFetchCall(mock);
      expect(url).toBe('https://cb.test/agenttool/v1/webfetch');

      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      expect(body.url).toBe('https://a.test/page');
      expect(body.prompt).toBe('the release date');
      expect(body.format).toBe('markdown');

      expect(result.content).toContain('Body text');
      expect(result.url).toBe('https://a.test');
    });

    it('treats empty content as a failure', async () => {
      stubFetch(async () => makeJsonResponse({ content: '   ' }));

      await expect(
        runWebFetch({
          provider: createCodeBuddyFetchProvider({
            resolveEndpoint: async () => 'https://cb.test',
            resolveToken: async () => 'token',
          }),
          query: { url: 'https://a.test' },
        }),
      ).resolves.toContain('no readable content');
    });

    it('reports a missing URL without calling the endpoint', async () => {
      const mock = stubFetch(async () => makeJsonResponse({ content: 'x' }));

      await expect(
        runWebFetch({
          provider: createCodeBuddyFetchProvider({
            resolveEndpoint: async () => 'https://cb.test',
            resolveToken: async () => 'token',
          }),
          query: { url: '  ' },
        }),
      ).resolves.toContain('without a URL');
      expect(mock).not.toHaveBeenCalled();
    });
  });

  describe('local fetch provider', () => {
    it('converts html to text', async () => {
      stubFetch(
        async () =>
          new Response(
            '<html><head><title>T</title></head><body><script>bad()</script><h1>Hello</h1><p>World &amp; friends</p></body></html>',
            { headers: { 'Content-Type': 'text/html' }, status: 200 },
          ),
      );

      const result = await createLocalFetchProvider().fetch({
        url: 'https://a.test/page',
      });

      expect(result.content).toContain('Hello');
      expect(result.content).toContain('World & friends');
      expect(result.content).not.toContain('bad()');
      expect(result.content).not.toContain('<h1>');
    });

    it('refuses a private address before connecting', async () => {
      const mock = stubFetch(async () => makeJsonResponse({ content: 'x' }));

      await expect(
        runWebFetch({
          provider: createLocalFetchProvider(),
          query: { url: 'http://127.0.0.1/admin' },
        }),
      ).resolves.toContain('private or loopback');
      expect(mock).not.toHaveBeenCalled();
    });

    it('refuses a non-http scheme', async () => {
      const mock = stubFetch(async () => makeJsonResponse({ content: 'x' }));

      await expect(
        runWebFetch({
          provider: createLocalFetchProvider(),
          query: { url: 'file:///etc/passwd' },
        }),
      ).resolves.toContain('Unsupported URL protocol');
      expect(mock).not.toHaveBeenCalled();
    });

    it('refuses a redirect onto a private address', async () => {
      stubFetch(
        async () =>
          new Response(null, {
            headers: { location: 'http://169.254.169.254/latest/meta-data' },
            status: 302,
          }),
      );

      await expect(
        runWebFetch({
          provider: createLocalFetchProvider(),
          query: { url: 'https://a.test/page' },
        }),
      ).resolves.toContain('private or loopback');
    });

    it('rejects an unsupported content type', async () => {
      stubFetch(
        async () =>
          new Response('binary', {
            headers: { 'Content-Type': 'application/pdf' },
            status: 200,
          }),
      );

      await expect(
        runWebFetch({
          provider: createLocalFetchProvider(),
          query: { url: 'https://a.test/f.pdf' },
        }),
      ).resolves.toContain('unsupported content type');
    });

    it('reports an invalid URL without connecting', async () => {
      const mock = stubFetch(async () => makeJsonResponse({ content: 'x' }));

      await expect(
        runWebFetch({
          provider: createLocalFetchProvider(),
          query: { url: 'not-a-url' },
        }),
      ).resolves.toContain('not a valid absolute URL');
      expect(mock).not.toHaveBeenCalled();
    });
  });

  describe('fetch tool definition', () => {
    it('requires only a url', () => {
      const tool = buildWebFetchToolDefinition();

      expect(tool.name).toBe('web_fetch');
      expect(tool.parameters).toMatchObject({
        properties: {
          prompt: { type: 'string' },
          url: { type: 'string' },
        },
        required: ['url'],
        type: 'object',
      });
    });
  });

  describe('settings', () => {
    it('defaults web fetch to off with a codebuddy backend', async () => {
      const config = await getActiveConfig();

      expect(config.CODEBUDDY_WEB_FETCH_ENABLED).toBe(false);
      expect(config.CODEBUDDY_WEB_FETCH_BACKEND).toBe('codebuddy');
      expect(config.CODEBUDDY_WEB_SEARCH_BACKEND).toBe('searxng');
    });

    it('is disabled by default and enabled by the console', async () => {
      await expect(isWebFetchEnabled()).resolves.toBe(false);

      await updateSettings({ CODEBUDDY_WEB_FETCH_ENABLED: 'true' });

      await expect(isWebFetchEnabled()).resolves.toBe(true);
    });
  });

  describe('token scoping', () => {
    it('uses the credential backing the request', async () => {
      const seen: string[] = [];

      await withCodeBuddyToken(
        async () => 'scoped-token',
        async () => {
          seen.push(
            String(
              await (
                await import('@/lib/server/search/token')
              ).resolveCodeBuddyToken(),
            ),
          );
        },
      );

      expect(seen).toEqual(['scoped-token']);
    });
  });

  describe('proxy integration', () => {
    const runOnce = async ({
      fetchImpl,
      tools,
    }: {
      fetchImpl: (...args: unknown[]) => Promise<Response>;
      tools: unknown[];
    }): Promise<Response> => {
      await withCredential();
      stubFetch(fetchImpl);

      const context = createProxyContextFromCredential({
        data: { bearer_token: 'cred-token', user_id: 'tester' },
        filePath: '/tmp/cred.json',
        filename: 'cred.json',
      });

      const response = await proxyChatCompletions(
        new NextRequest('http://localhost/v1/chat/completions', {
          method: 'POST',
        }),
        {
          messages: [{ content: 'hi', role: 'user' }],
          tools,
        } as ChatRequestBody,
        context,
      );

      return response;
    };

    it('executes a web_fetch call through the local backend', async () => {
      await updateSettings({
        CODEBUDDY_WEB_FETCH_ENABLED: 'true',
        CODEBUDDY_WEB_FETCH_BACKEND: 'local',
      });

      let call = 0;
      const response = await runOnce({
        fetchImpl: async (...args: unknown[]) => {
          const url = String(args[0]);

          if (url.includes('/v2/chat/completions')) {
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
                              arguments: '{"url":"https://a.test/page"}',
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
                    { finish_reason: 'stop', message: { content: 'Fetched.' } },
                  ],
                });
          }

          return new Response('<html><body><p>Page body</p></body></html>', {
            headers: { 'Content-Type': 'text/html' },
            status: 200,
          });
        },
        tools: [{ type: 'function', function: buildWebFetchToolDefinition() }],
      });

      const payload = (await response.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      expect(payload.choices[0]?.message.content).toBe('Fetched.');
      expect(call).toBe(2);
    });

    it('drops a fetch server-tool declaration it cannot execute', async () => {
      await updateSettings({
        // Fetch is on but pointed at `none`, so no provider can serve it.
        CODEBUDDY_WEB_FETCH_ENABLED: 'true',
        CODEBUDDY_WEB_FETCH_BACKEND: 'none',
        CODEBUDDY_WEB_SEARCH_ENABLED: 'true',
        CODEBUDDY_WEB_SEARCH_BACKEND: 'none',
      });

      let upstreamTools: unknown[] | undefined;
      await executeWebSearchLoop({
        body: {
          messages: [{ content: 'hi', role: 'user' }],
          tools: [
            { type: 'web_fetch_20250910', name: 'web_fetch' },
            { type: 'function', function: { name: 'keep_me' } },
          ],
        } as ChatRequestBody,
        callUpstream: async (loopBody) => {
          upstreamTools = loopBody.tools;

          return makeJsonResponse({
            choices: [
              { finish_reason: 'stop', message: { content: 'No tools.' } },
            ],
          });
        },
      });

      // The server-tool declaration upstream would not understand is dropped,
      // while the client's own function is untouched.
      expect(upstreamTools).toEqual([
        { type: 'function', function: { name: 'keep_me' } },
      ]);
    });

    it('leaves a client-declared web_fetch function alone when disabled', async () => {
      await updateSettings({
        CODEBUDDY_WEB_FETCH_ENABLED: 'false',
        CODEBUDDY_WEB_FETCH_BACKEND: 'none',
        CODEBUDDY_WEB_SEARCH_ENABLED: 'false',
        CODEBUDDY_WEB_SEARCH_BACKEND: 'searxng',
      });

      const declared = {
        type: 'function',
        function: { name: 'web_fetch', parameters: { type: 'object' } },
      };
      let upstreamTools: unknown[] | undefined;
      const result = await executeWebSearchLoop({
        body: {
          messages: [{ content: 'hi', role: 'user' }],
          tools: [declared],
        } as ChatRequestBody,
        callUpstream: async (loopBody) => {
          upstreamTools = loopBody.tools;

          return makeJsonResponse({
            choices: [
              { finish_reason: 'stop', message: { content: 'No tools.' } },
            ],
          });
        },
      });

      // The client resolves its own tool, so the proxy must not delete it even
      // though local fetch is off — and with nothing to execute, the loop
      // declines to run at all.
      expect(result).toBeNull();
      expect(upstreamTools).toBeUndefined();
    });
  });
});
