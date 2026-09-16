import fs from 'node:fs';
import path from 'node:path';

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
import { translateResponsesToolsToChat } from '@/lib/server/proxy/responses';
import {
  resolveCodeBuddyToken,
  withCodeBuddyToken,
} from '@/lib/server/search/token';

/**
 * Settings persist to storage, and the storage directory defaults to the
 * process working directory — so writes here would leak into any test file that
 * runs later in the same worker. Pointing storage at a scratch directory keeps
 * this file's settings to itself.
 */
const tempRootDir = path.join(process.cwd(), '.tmp-test-server-tools-root');
const tempDataDir = path.join(tempRootDir, '.codebuddy_data');
const tempCredsDir = path.join(tempRootDir, '.codebuddy_creds');

const cleanupDir = (): void => {
  fs.rmSync(tempRootDir, { force: true, recursive: true });
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
    cleanupDir();
    fs.mkdirSync(tempDataDir, { recursive: true });
    fs.mkdirSync(tempCredsDir, { recursive: true });
    vi.spyOn(process, 'cwd').mockReturnValue(tempRootDir);
  });

  afterEach(async () => {
    resetWebSearchProviders();
    resetCredentialRuntimeState();
    resetUsageStats();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    cleanupDir();
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

    it('shapes results that lack snippets or titles', async () => {
      stubFetch(async () =>
        makeJsonResponse({
          results: [
            { content: 'fallback snippet', url: 'https://a.test' },
            { title: 'Only title' },
            'not-an-object',
          ],
        }),
      );

      const result = await createCodeBuddySearchProvider({
        resolveEndpoint: async () => 'https://cb.test',
        resolveToken: async () => 'token',
      }).search('anything here');

      expect(result.results).toHaveLength(2);
      expect(result.results[0]?.content).toBe('fallback snippet');
      expect(result.results[1]?.title).toBe('Only title');
      expect(result.content).toContain('(untitled)');
    });

    it('tolerates a payload with no results array', async () => {
      stubFetch(async () => makeJsonResponse({}));

      const result = await createCodeBuddySearchProvider({
        resolveEndpoint: async () => 'https://cb.test',
        resolveToken: async () => 'token',
      }).search('anything here');

      expect(result.results).toEqual([]);
      expect(result.content).toContain('returned no results');
    });

    it('surfaces an error payload with no message', async () => {
      stubFetch(async () => makeJsonResponse({ code: 7 }));

      await expect(
        runWebSearch({
          provider: createCodeBuddySearchProvider({
            resolveEndpoint: async () => 'https://cb.test',
            resolveToken: async () => 'token',
          }),
          query: 'hello',
        }),
      ).resolves.toContain('Unknown error');
    });

    it('falls back to the status when the error body is empty', async () => {
      stubFetch(async () => new Response('', { status: 500 }));

      await expect(
        runWebSearch({
          provider: createCodeBuddySearchProvider({
            resolveEndpoint: async () => 'https://cb.test',
            resolveToken: async () => 'token',
          }),
          query: 'hello',
        }),
      ).resolves.toContain('failed with HTTP 500');
    });

    it('falls back to the status when the error body is not JSON', async () => {
      stubFetch(async () => new Response('<html>502</html>', { status: 502 }));

      await expect(
        runWebSearch({
          provider: createCodeBuddySearchProvider({
            resolveEndpoint: async () => 'https://cb.test',
            resolveToken: async () => 'token',
          }),
          query: 'hello',
        }),
      ).resolves.toContain('failed with HTTP 502');
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

    it('refuses to call the endpoint without a token', async () => {
      const mock = stubFetch(async () => makeJsonResponse({ content: 'x' }));

      await expect(
        runWebFetch({
          provider: createCodeBuddyFetchProvider({
            resolveEndpoint: async () => 'https://cb.test',
            resolveToken: async () => null,
          }),
          query: { url: 'https://a.test' },
        }),
      ).resolves.toContain('Authentication required');
      expect(mock).not.toHaveBeenCalled();
    });

    it('reports a non-ok HTTP status', async () => {
      stubFetch(async () => makeJsonResponse({ msg: 'bad gateway' }, 502));

      await expect(
        runWebFetch({
          provider: createCodeBuddyFetchProvider({
            resolveEndpoint: async () => 'https://cb.test',
            resolveToken: async () => 'token',
          }),
          query: { url: 'https://a.test' },
        }),
      ).resolves.toContain('CodeBuddy web fetch error: bad gateway');
    });

    it('falls back to the status when the error body is empty', async () => {
      stubFetch(async () => new Response('', { status: 503 }));

      await expect(
        runWebFetch({
          provider: createCodeBuddyFetchProvider({
            resolveEndpoint: async () => 'https://cb.test',
            resolveToken: async () => 'token',
          }),
          query: { url: 'https://a.test' },
        }),
      ).resolves.toContain('failed with HTTP 503');
    });

    it('surfaces an error payload with no message', async () => {
      stubFetch(async () => makeJsonResponse({ code: 9 }));

      await expect(
        runWebFetch({
          provider: createCodeBuddyFetchProvider({
            resolveEndpoint: async () => 'https://cb.test',
            resolveToken: async () => 'token',
          }),
          query: { url: 'https://a.test' },
        }),
      ).resolves.toContain('Unknown error');
    });

    it('falls back to the requested URL when none is returned', async () => {
      stubFetch(async () => makeJsonResponse({ content: 'Body' }));

      const result = await createCodeBuddyFetchProvider({
        resolveEndpoint: async () => 'https://cb.test',
        resolveToken: async () => 'token',
      }).fetch({ url: 'https://a.test/page' });

      expect(result.url).toBe('https://a.test/page');
      expect(result.content).toContain('Body');
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

    it('refuses localhost and other reserved hosts', async () => {
      const mock = stubFetch(async () => makeJsonResponse({ content: 'x' }));

      for (const url of [
        'http://localhost/admin',
        'http://internal.localhost/admin',
        'http://[::1]/admin',
        'http://[fd00::1]/admin',
        'http://0.0.0.0/admin',
        'http://172.20.0.1/admin',
        'http://10.1.2.3/admin',
        'http://192.168.1.1/admin',
      ]) {
        await expect(
          runWebFetch({ provider: createLocalFetchProvider(), query: { url } }),
        ).resolves.toContain('private or loopback');
      }

      expect(mock).not.toHaveBeenCalled();
    });

    it('allows a public host', async () => {
      stubFetch(
        async () =>
          new Response('plain text body', {
            headers: { 'Content-Type': 'text/plain' },
            status: 200,
          }),
      );

      const result = await runWebFetch({
        provider: createLocalFetchProvider(),
        query: { url: 'https://93.184.216.34/page' },
      });

      expect(result).toContain('plain text body');
    });

    it('reports a redirect with no target', async () => {
      stubFetch(async () => new Response(null, { status: 302 }));

      await expect(
        runWebFetch({
          provider: createLocalFetchProvider(),
          query: { url: 'https://a.test/page' },
        }),
      ).resolves.toContain('redirect with no target');
    });

    it('reports too many redirects', async () => {
      stubFetch(
        async () =>
          new Response(null, {
            headers: { location: 'https://a.test/next' },
            status: 302,
          }),
      );

      await expect(
        runWebFetch({
          provider: createLocalFetchProvider(),
          query: { url: 'https://a.test/page' },
        }),
      ).resolves.toContain('more than 5 redirects');
    });

    it('reports an HTTP error status', async () => {
      stubFetch(async () => new Response('gone', { status: 404 }));

      await expect(
        runWebFetch({
          provider: createLocalFetchProvider(),
          query: { url: 'https://a.test/page' },
        }),
      ).resolves.toContain('Web fetch failed with HTTP 404');
    });

    it('reports a page with no readable text', async () => {
      stubFetch(
        async () =>
          new Response('   ', {
            headers: { 'Content-Type': 'text/html' },
            status: 200,
          }),
      );

      await expect(
        runWebFetch({
          provider: createLocalFetchProvider(),
          query: { url: 'https://a.test/page' },
        }),
      ).resolves.toContain('no readable content');
    });

    it('follows a redirect to another public host', async () => {
      let call = 0;
      stubFetch(async () => {
        call += 1;

        return call === 1
          ? new Response(null, {
              headers: { location: 'https://b.test/final' },
              status: 301,
            })
          : new Response('<p>Final page</p>', {
              headers: { 'Content-Type': 'text/html' },
              status: 200,
            });
      });

      const result = await runWebFetch({
        provider: createLocalFetchProvider(),
        query: { url: 'https://a.test/page' },
      });

      expect(result).toContain('Final page');
    });

    it('decodes entities when converting html', async () => {
      stubFetch(
        async () =>
          new Response('<p>a &amp; b &lt;c&gt; &#65;</p>', {
            headers: { 'Content-Type': 'text/html' },
            status: 200,
          }),
      );

      const result = await runWebFetch({
        provider: createLocalFetchProvider(),
        query: { url: 'https://a.test/page' },
      });

      expect(result).toContain('a & b <c> A');
    });

    it('passes plain text through unchanged', async () => {
      stubFetch(
        async () =>
          new Response('a &amp; b', {
            headers: { 'Content-Type': 'text/plain' },
            status: 200,
          }),
      );

      // Entities are only decoded on the HTML path: a text/plain body is
      // literal text, and decoding it would corrupt the content.
      const result = await runWebFetch({
        provider: createLocalFetchProvider(),
        query: { url: 'https://a.test/t.txt' },
      });

      expect(result).toContain('a &amp; b');
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

  describe('responses tool translation', () => {
    it('emits web_fetch as a callable function', () => {
      const result = translateResponsesToolsToChat([
        { type: 'web_fetch_20250910', name: 'web_fetch' },
      ]) as Array<{ function: { name: string } }>;

      expect(result.map((entry) => entry.function.name)).toEqual(['web_fetch']);
    });

    it('emits both server tools when declared together', () => {
      process.env.SEARXNG_URL = 'https://searx.test';
      resetWebSearchProviders();

      const result = translateResponsesToolsToChat([
        { type: 'web_search_preview' },
        { type: 'web_fetch_20250910', name: 'web_fetch' },
      ]) as Array<{ function: { name: string } }>;

      expect(result.map((entry) => entry.function.name)).toEqual([
        'web_search',
        'web_fetch',
      ]);

      delete process.env.SEARXNG_URL;
      resetWebSearchProviders();
    });

    it('leaves an unrelated server tool alone', () => {
      process.env.SEARXNG_URL = 'https://searx.test';
      resetWebSearchProviders();

      expect(
        translateResponsesToolsToChat([{ type: 'file_search' }]),
      ).toBeUndefined();

      delete process.env.SEARXNG_URL;
      resetWebSearchProviders();
    });
  });

  describe('token scoping', () => {
    it('uses the credential backing the request', async () => {
      const seen: string[] = [];

      await withCodeBuddyToken(
        async () => 'scoped-token',
        async () => {
          seen.push(String(await resolveCodeBuddyToken()));
        },
      );

      expect(seen).toEqual(['scoped-token']);
    });

    it('falls back to a saved credential outside a request scope', async () => {
      await withCredential();

      await expect(resolveCodeBuddyToken()).resolves.toBe('cred-token');
    });

    it('reports no token when no credential exists', async () => {
      await expect(resolveCodeBuddyToken()).resolves.toBeNull();
    });

    it('ignores a credential that carries no bearer token', async () => {
      await addCredential({
        access_token: '',
        created_at: Math.floor(Date.now() / 1000),
        user_id: 'empty',
      });

      await expect(resolveCodeBuddyToken()).resolves.toBeNull();
    });
  });

  describe('registry fallbacks', () => {
    it('normalizes a blank search backend to the default', () => {
      expect(normalizeSearchBackend('')).toBe('searxng');
    });

    it('falls back to searxng for an unknown search backend', () => {
      // No SEARXNG_URL here, so the fallback resolves to a backend that cannot
      // be constructed — the point is that an unknown value is not an error.
      expect(
        resolveSearchProvider('bogus', async () => 'https://cb.test'),
      ).toBeNull();
    });

    it('falls back to no backend for an unknown fetch backend', () => {
      // Unlike search, an unrecognised fetch value resolves to nothing: silently
      // enabling a backend that fetches arbitrary model-supplied URLs would be
      // the wrong default.
      expect(
        resolveFetchProvider('bogus', async () => 'https://cb.test'),
      ).toBeNull();
    });

    it('reports no provider when the search backend resolves to none', () => {
      expect(
        resolveSearchProvider('none', async () => 'https://cb.test'),
      ).toBeNull();
    });

    it('reuses one local fetch provider across calls', () => {
      expect(resolveFetchProvider('local', async () => 'https://cb.test')).toBe(
        resolveFetchProvider('local', async () => 'https://cb.test'),
      );
    });

    it('reports no configured backend when a search runs unscoped', async () => {
      await expect(
        runWebSearch({ backend: 'searxng', query: 'hello' }),
      ).resolves.toContain('no local search backend is configured');
    });

    it('reports no enabled backend when a fetch runs unscoped', async () => {
      await expect(
        runWebFetch({ backend: 'none', query: { url: 'https://a.test' } }),
      ).resolves.toContain('no web fetch backend is enabled');
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
