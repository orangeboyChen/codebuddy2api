import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { NextRequest } from 'next/server';

import {
  getActiveConfig,
  isWebFetchEnabled,
  isWebSearchEnabled,
  updateSettings,
} from '@/lib/server/domain/config';
import {
  createCodeBuddyFetchProvider,
  normalizeFetchUrl,
} from '@/lib/server/search/providers/codebuddy-fetch';
import { createCodeBuddySearchProvider } from '@/lib/server/search/providers/codebuddy-search';
import {
  createLocalFetchProvider,
  type HostResolver,
} from '@/lib/server/search/providers/local-fetch';
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
import {
  buildWebFetchToolDefinition,
  buildWebSearchToolDefinition,
  isMarkedServerTool,
  normalizeToolName,
  stripServerToolMarker,
} from '@/lib/server/search/tool';
import { executeWebSearchLoop } from '@/lib/server/proxy/web-search-loop';
import { translateResponsesToolsToChat } from '@/lib/server/proxy/responses';
import {
  pickCredentialToken,
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

/**
 * Reads the loop's buffered payload, asserting the loop produced a response.
 *
 * `executeWebSearchLoop` legitimately returns a null response when no backend
 * can run the declared tools, so assertions on the payload have to rule that
 * out rather than reading through a nullable.
 */
const readPayload = async (
  result: { response: Response | null } | null,
): Promise<Record<string, unknown>> => {
  if (!result?.response) {
    throw new Error('Expected the server-tool loop to produce a response');
  }

  return (await result.response.json()) as Record<string, unknown>;
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
      ['PASSTHROUGH', 'passthrough'],
    ])('accepts %s as a search backend', (input, expected) => {
      expect(normalizeSearchBackend(input)).toBe(expected);
    });

    it('falls back to the default for an unknown search backend', () => {
      expect(normalizeSearchBackend('bogus')).toBe('searxng');
      expect(normalizeSearchBackend(undefined)).toBe('searxng');
    });

    it('falls back to the default for an unknown fetch backend', () => {
      expect(normalizeFetchBackend('bogus')).toBe('passthrough');
      expect(normalizeFetchBackend(null)).toBe('passthrough');
    });

    it('accepts the previous backend names', () => {
      // An upgrade must not silently change which side runs the tool: `local`
      // and `none` are how these were saved before the rename.
      expect(normalizeFetchBackend('local')).toBe('codebuddy2api');
      expect(normalizeFetchBackend('none')).toBe('passthrough');
      expect(normalizeSearchBackend('none')).toBe('passthrough');
    });

    it('resolves the renamed backends to the same providers', () => {
      expect(
        resolveFetchProvider('local', async () => 'https://cb.test')?.id,
      ).toBe('local');
      expect(
        resolveFetchProvider('codebuddy2api', async () => 'https://cb.test')
          ?.id,
      ).toBe('local');
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

  describe('provider resolution', () => {
    it('resolves the codebuddy search backend', () => {
      expect(
        resolveSearchProvider('codebuddy', async () => 'https://cb.test')?.id,
      ).toBe('codebuddy');
    });

    it('resolves the local fetch backend', () => {
      expect(
        resolveFetchProvider('local', async () => 'https://cb.test')?.id,
      ).toBe('local');
    });

    it('resolves the codebuddy fetch backend', () => {
      expect(
        resolveFetchProvider('codebuddy', async () => 'https://cb.test')?.id,
      ).toBe('codebuddy');
    });
  });

  describe('token resolution', () => {
    it('prefers bearer_token', () => {
      expect(
        pickCredentialToken({ access_token: 'a', bearer_token: 'b' }),
      ).toBe('b');
    });

    it('falls back to access_token when bearer_token is empty', () => {
      // Empty must fall through, not just null: `??` would stop at the blank
      // and report "no token" for a credential that has one.
      expect(
        pickCredentialToken({ access_token: 'fallback', bearer_token: '' }),
      ).toBe('fallback');
    });

    it('falls back to access_token when bearer_token is missing', () => {
      expect(pickCredentialToken({ access_token: 'fallback' })).toBe(
        'fallback',
      );
    });

    it('treats a whitespace-only token as absent', () => {
      expect(
        pickCredentialToken({ access_token: '  ', bearer_token: ' ' }),
      ).toBeNull();
    });

    it('reports no token for an empty credential', () => {
      expect(pickCredentialToken({})).toBeNull();
    });
  });

  describe('declaration stripping', () => {
    it('keeps a client-declared web_search function when search cannot run', async () => {
      // Search is selected but unconfigured (no SEARXNG_URL), so nothing can
      // execute it — a client-owned function must survive untouched.
      await updateSettings({
        CODEBUDDY_WEB_FETCH_BACKEND: 'passthrough',
        CODEBUDDY_WEB_SEARCH_BACKEND: 'searxng',
      });

      const clientTool = {
        type: 'function',
        function: { name: 'web_search', parameters: { type: 'object' } },
      };

      const result = await executeWebSearchLoop({
        body: {
          messages: [{ content: 'hi', role: 'user' }],
          tools: [clientTool],
        } as ChatRequestBody,
        callUpstream: async () =>
          makeJsonResponse({
            choices: [
              { finish_reason: 'stop', message: { content: 'No tools.' } },
            ],
          }),
      });

      // Nothing matched a server-tool declaration, so the request is left
      // alone rather than rewritten.
      expect(result).toBeNull();
    });

    it.each(['passthrough', 'PASSTHROUGH', 'none'])(
      'passes through a server-declared search tool for %s',
      async (backend) => {
        await updateSettings({
          CODEBUDDY_WEB_FETCH_BACKEND: 'passthrough',
          CODEBUDDY_WEB_SEARCH_BACKEND: backend,
        });

        const result = await executeWebSearchLoop({
          body: {
            messages: [{ content: 'hi', role: 'user' }],
            tools: [{ type: 'web_search_20260209', name: 'web_search' }],
          } as ChatRequestBody,
          callUpstream: async () =>
            makeJsonResponse({
              choices: [
                { finish_reason: 'stop', message: { content: 'No tools.' } },
              ],
            }),
        });

        expect(result?.response).toBeNull();
        expect(result?.body.tools).toEqual([
          { type: 'web_search_20260209', name: 'web_search' },
        ]);
      },
    );

    it('reads a query from the first non-empty string field', async () => {
      process.env.SEARXNG_URL = 'https://searx.test';
      resetWebSearchProviders();
      await updateSettings({
        CODEBUDDY_WEB_SEARCH_BACKEND: 'searxng',
      });

      let searched = '';
      stubFetch(async (...args: unknown[]) => {
        const url = String(args[0]);

        if (url.includes('searx.test')) {
          searched = new URL(url).searchParams.get('q') ?? '';

          return makeJsonResponse({ results: [] });
        }

        return makeJsonResponse({
          choices: [{ finish_reason: 'stop', message: { content: 'done' } }],
        });
      });

      await executeWebSearchLoop({
        body: {
          messages: [{ content: 'hi', role: 'user' }],
          tools: [{ type: 'web_search_preview' }],
        } as ChatRequestBody,
        callUpstream: async () =>
          makeJsonResponse({
            choices: [
              {
                finish_reason: 'tool_calls',
                message: {
                  tool_calls: [
                    {
                      id: 'call_alias',
                      function: {
                        // No known key: the fallback takes the first string.
                        arguments: '{"whatever":"unexpected shape"}',
                        name: 'web_search',
                      },
                    },
                  ],
                },
              },
            ],
          }),
      });

      expect(searched).toBe('unexpected shape');

      delete process.env.SEARXNG_URL;
      resetWebSearchProviders();
    });
  });

  describe('url normalization', () => {
    it('upgrades http to https', () => {
      expect(normalizeFetchUrl('http://a.test/page')).toBe(
        'https://a.test/page',
      );
    });

    it('rewrites a github blob url to its raw equivalent', () => {
      // Without this the fetch returns the GitHub HTML viewer rather than the
      // file contents, which is almost never what was wanted.
      expect(
        normalizeFetchUrl('https://github.com/o/r/blob/main/README.md'),
      ).toBe('https://raw.githubusercontent.com/o/r/main/README.md');
    });

    it('rewrites a github blob url given over http', () => {
      expect(normalizeFetchUrl('http://github.com/o/r/blob/main/a.ts')).toBe(
        'https://raw.githubusercontent.com/o/r/main/a.ts',
      );
    });

    it('leaves an ordinary url untouched', () => {
      expect(normalizeFetchUrl('https://a.test/page')).toBe(
        'https://a.test/page',
      );
    });

    it('leaves a non-blob github url untouched', () => {
      expect(normalizeFetchUrl('https://github.com/o/r')).toBe(
        'https://github.com/o/r',
      );
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

    it('reports an HTTP error carrying no message', async () => {
      stubFetch(async () => makeJsonResponse({ code: 1 }, 500));

      await expect(
        runWebFetch({
          provider: createCodeBuddyFetchProvider({
            resolveEndpoint: async () => 'https://cb.test',
            resolveToken: async () => 'token',
          }),
          query: { url: 'https://a.test' },
        }),
      ).resolves.toContain('failed with HTTP 500');
    });

    it('falls back to Unknown error when the code carries no message', async () => {
      stubFetch(async () => makeJsonResponse({ code: 42 }));

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

    it('treats a non-string content field as empty', async () => {
      stubFetch(async () => makeJsonResponse({ content: { nope: true } }));

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

    it('omits the prompt from the result when none was given', async () => {
      stubFetch(async () => makeJsonResponse({ content: 'Body text' }));

      const result = await createCodeBuddyFetchProvider({
        resolveEndpoint: async () => 'https://cb.test',
        resolveToken: async () => 'token',
      }).fetch({ url: 'https://a.test/page' });

      expect(result.content).not.toContain('Requested focus');
    });

    it('falls back to a local fetch when the endpoint fails', async () => {
      // This is the behaviour that keeps data flowing: the CLI races the
      // endpoint against a local fetch, so an endpoint failure alone must not
      // lose the page.
      //
      // The fallback uses `node:http` rather than `fetch`, so it cannot be
      // stubbed — it gets a real local server and an injected resolver that
      // points the hostname at it.
      const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('local copy of the page');
      });
      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();

      if (!address || typeof address === 'string') {
        throw new Error('failed to start test server');
      }

      stubFetch(async () => makeJsonResponse({ msg: 'endpoint down' }, 502));

      try {
        const resolveHost: HostResolver = Object.assign(
          async () => ['127.0.0.1'],
          { trusted: true },
        );

        await expect(
          runWebFetch({
            provider: createCodeBuddyFetchProvider({
              resolveEndpoint: async () => 'https://cb.test',
              resolveHost,
              resolveToken: async () => 'token',
            }),
            query: { url: `http://fallback.test:${address.port}/page` },
          }),
        ).resolves.toContain('local copy of the page');
      } finally {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      }
    });

    it('reports one reason when both failures agree', async () => {
      // The host cannot resolve, so the local fallback fails with exactly the
      // message the endpoint reports. Repeating it would just be noise.
      const reason = 'Web fetch could not resolve host: a.test';
      stubFetch(async () => {
        throw new Error(reason);
      });

      await expect(
        runWebFetch({
          provider: createCodeBuddyFetchProvider({
            resolveEndpoint: async () => 'https://cb.test',
            resolveToken: async () => 'token',
          }),
          query: { url: 'https://a.test/page' },
        }),
      ).resolves.toContain(`Web fetch failed: ${reason}.`);

      await expect(
        runWebFetch({
          provider: createCodeBuddyFetchProvider({
            resolveEndpoint: async () => 'https://cb.test',
            resolveToken: async () => 'token',
          }),
          query: { url: 'https://a.test/page' },
        }),
      ).resolves.not.toContain('local fallback also failed');
    });

    it('handles a non-Error failure from the fallback', async () => {
      stubFetch(async () => {
        throw 'endpoint string failure';
      });

      await expect(
        runWebFetch({
          provider: createCodeBuddyFetchProvider({
            resolveEndpoint: async () => 'https://cb.test',
            resolveToken: async () => 'token',
          }),
          query: { url: 'https://a.test/page' },
        }),
      ).resolves.toContain('local fallback also failed');
    });

    it('reports both reasons when the endpoint and the fallback fail', async () => {
      stubFetch(async () => makeJsonResponse({ msg: 'endpoint down' }, 502));

      await expect(
        runWebFetch({
          provider: createCodeBuddyFetchProvider({
            resolveEndpoint: async () => 'https://cb.test',
            resolveToken: async () => 'token',
          }),
          query: { url: 'https://a.test/page' },
        }),
      ).resolves.toContain('local fallback also failed');
    });

    it('refuses a non-text response', async () => {
      stubFetch(async () =>
        makeJsonResponse({
          content: 'binary bytes',
          content_type: 'application/pdf',
        }),
      );

      await expect(
        runWebFetch({
          provider: createCodeBuddyFetchProvider({
            resolveEndpoint: async () => 'https://cb.test',
            resolveToken: async () => 'token',
          }),
          query: { url: 'https://a.test/f.pdf' },
        }),
      ).resolves.toContain('non-text resource');
    });

    it('refuses an image response', async () => {
      stubFetch(async () =>
        makeJsonResponse({ content: 'bytes', content_type: 'image/png' }),
      );

      await expect(
        runWebFetch({
          provider: createCodeBuddyFetchProvider({
            resolveEndpoint: async () => 'https://cb.test',
            resolveToken: async () => 'token',
          }),
          query: { url: 'https://a.test/p.png' },
        }),
      ).resolves.toContain('non-text resource');
    });

    it('accepts a text response with a charset suffix', async () => {
      stubFetch(async () =>
        makeJsonResponse({
          content: 'Hello there',
          content_type: 'text/html; charset=utf-8',
        }),
      );

      await expect(
        runWebFetch({
          provider: createCodeBuddyFetchProvider({
            resolveEndpoint: async () => 'https://cb.test',
            resolveToken: async () => 'token',
          }),
          query: { url: 'https://a.test/page' },
        }),
      ).resolves.toContain('Hello there');
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
    /**
     * A real server, because the backend no longer goes through `globalThis.fetch`:
     * it resolves the host itself and pins the socket to the validated address,
     * so a stubbed `fetch` cannot exercise the SSRF path at all.
     */
    let server: http.Server;
    let baseUrl: string;
    let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;

    beforeEach(async () => {
      handler = (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
      };
      server = http.createServer((req, res) => handler(req, res));
      await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();

      if (!address || typeof address === 'string') {
        throw new Error('failed to start test server');
      }

      // A name that need not resolve anywhere: the injected resolver answers for
      // it, so no DNS or network access is involved. It must not be `127.0.0.1`,
      // which the private-address check refuses before it proves anything.
      baseUrl = `http://public.test:${address.port}`;
    });

    afterEach(async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    });

    /**
     * Resolves the test hostname to the loopback address the server is bound to.
     *
     * The address itself is refused by the private-range check, so this override
     * is what lets a test reach a local server while still exercising the real
     * resolve → validate → pin path. Pinning then connects to 127.0.0.1 while the
     * request still names the public hostname.
     */
    const resolveToLocalServer: HostResolver = Object.assign(
      async () => ['127.0.0.1'],
      { trusted: true },
    );

    /**
     * A resolver whose answers are validated.
     *
     * The provider only applies the private-address check to answers coming from
     * its DNS resolver — an injected resolver is an explicit operator pin, and
     * pinning a name to a private address is legitimate. These wrappers produce
     * values that look like DNS answers so the validation path is exercised.
     */
    const dnsReturning = (addresses: string[]): HostResolver =>
      Object.assign(async () => addresses, { trusted: false });

    const fetchWith = (
      url: string,
      options: { resolveHost?: HostResolver } = {},
    ) =>
      runWebFetch({
        provider: createLocalFetchProvider({
          resolveHost: options.resolveHost ?? resolveToLocalServer,
        }),
        query: { url },
      });

    it('converts html to text', async () => {
      handler = (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(
          '<html><head><title>T</title></head><body><script>bad()</script><h1>Hello</h1><p>World &amp; friends</p></body></html>',
        );
      };

      const result = await createLocalFetchProvider({
        resolveHost: resolveToLocalServer,
      }).fetch({ url: `${baseUrl}/page` });

      expect(result.content).toContain('Hello');
      expect(result.content).toContain('World & friends');
      expect(result.content).not.toContain('bad()');
      expect(result.content).not.toContain('<h1>');
    });

    it('preserves the host header while pinning the address', async () => {
      let seenHost: string | undefined;
      handler = (req, res) => {
        seenHost = req.headers.host;
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
      };

      await fetchWith(`${baseUrl}/page`);

      // The connection is pinned to the validated IP, but the request still has
      // to name the original host so virtual-host routing and TLS SNI work.
      expect(seenHost).toBe(`public.test:${new URL(baseUrl).port}`);
    });

    it('refuses a private address before connecting', async () => {
      const mock = stubFetch(async () => makeJsonResponse({ content: 'x' }));

      await expect(fetchWith('http://127.0.0.1/admin')).resolves.toContain(
        'private or loopback',
      );
      expect(mock).not.toHaveBeenCalled();
    });

    it('refuses a hostname that resolves to a private address', async () => {
      // A public-looking name whose resolution is a private address must still be
      // refused: validating only the hostname string would let it through, and
      // pinning means the connection would then go to the loopback address.
      await expect(
        fetchWith('http://private.test/page', {
          resolveHost: dnsReturning(['127.0.0.1']),
        }),
      ).resolves.toContain('resolves to the private address');
    });

    it('refuses a non-http scheme', async () => {
      const mock = stubFetch(async () => makeJsonResponse({ content: 'x' }));

      await expect(fetchWith('file:///etc/passwd')).resolves.toContain(
        'Unsupported URL protocol',
      );
      expect(mock).not.toHaveBeenCalled();
    });

    it('refuses a redirect onto a private address', async () => {
      handler = (_req, res) => {
        res.writeHead(302, { location: 'http://169.254.169.254/latest' });
        res.end();
      };

      await expect(fetchWith(`${baseUrl}/page`)).resolves.toContain(
        'private or loopback',
      );
    });

    it('rejects an unsupported content type', async () => {
      handler = (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/pdf' });
        res.end('binary');
      };

      await expect(fetchWith(`${baseUrl}/f.pdf`)).resolves.toContain(
        'unsupported content type',
      );
    });

    it('reports an invalid URL without connecting', async () => {
      await expect(fetchWith('not-a-url')).resolves.toContain(
        'not a valid absolute URL',
      );
    });

    it('reports a blank URL without connecting', async () => {
      await expect(fetchWith('   ')).resolves.toContain('without a URL');
    });

    it('follows a redirect whose location header is an array', async () => {
      let call = 0;
      handler = (_req, res) => {
        call += 1;

        if (call === 1) {
          // Node exposes repeated headers as an array, and only the first is
          // used. `setHeader` accepts that array shape, but it has to run
          // before `writeHead` commits the headers.
          res.setHeader('location', [`${baseUrl}/final`, '/ignored']);
          res.writeHead(302);
          res.end();
          return;
        }

        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('final body');
      };

      await expect(fetchWith(`${baseUrl}/page`)).resolves.toContain(
        'final body',
      );
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
        await expect(fetchWith(url)).resolves.toContain('private or loopback');
      }

      expect(mock).not.toHaveBeenCalled();
    });

    it('reports a redirect with no target', async () => {
      handler = (_req, res) => {
        res.writeHead(302);
        res.end();
      };

      await expect(fetchWith(`${baseUrl}/page`)).resolves.toContain(
        'redirect with no target',
      );
    });

    it('reports too many redirects', async () => {
      handler = (_req, res) => {
        res.writeHead(302, { location: `${baseUrl}/next` });
        res.end();
      };

      await expect(fetchWith(`${baseUrl}/page`)).resolves.toContain(
        'more than 5 redirects',
      );
    });

    it('reports an HTTP error status', async () => {
      handler = (_req, res) => {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('gone');
      };

      await expect(fetchWith(`${baseUrl}/page`)).resolves.toContain(
        'Web fetch failed with HTTP 404',
      );
    });

    it('reports a page with no readable text', async () => {
      handler = (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('   ');
      };

      await expect(fetchWith(`${baseUrl}/page`)).resolves.toContain(
        'no readable content',
      );
    });

    it('follows a redirect to another public host', async () => {
      let call = 0;
      handler = (_req, res) => {
        call += 1;

        if (call === 1) {
          res.writeHead(301, { location: `${baseUrl}/final` });
          res.end();
          return;
        }

        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<p>Final page</p>');
      };

      await expect(fetchWith(`${baseUrl}/page`)).resolves.toContain(
        'Final page',
      );
    });

    it('decodes entities when converting html', async () => {
      handler = (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<p>a &amp; b &lt;c&gt; &#65;</p>');
      };

      await expect(fetchWith(`${baseUrl}/page`)).resolves.toContain(
        'a & b <c> A',
      );
    });

    it('passes plain text through unchanged', async () => {
      handler = (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('a &amp; b');
      };

      // Entities are only decoded on the HTML path: a text/plain body is literal
      // text, and decoding it would corrupt the content.
      await expect(fetchWith(`${baseUrl}/t.txt`)).resolves.toContain(
        'a &amp; b',
      );
    });

    it('reports a hostname whose DNS lookup fails', async () => {
      await expect(
        fetchWith('http://nx.test/page', {
          resolveHost: async () => {
            throw new Error('dns boom');
          },
        }),
      ).resolves.toContain('could not resolve host');
    });

    it('treats a missing content type as text', async () => {
      handler = (_req, res) => {
        res.writeHead(200);
        res.end('plain body');
      };

      await expect(fetchWith(`${baseUrl}/page`)).resolves.toContain(
        'plain body',
      );
    });

    it('reports a connection dropped mid-body', async () => {
      // The socket is destroyed instead of left hanging: an abrupt close fails
      // fast and deterministically, whereas asserting on a stalled body would
      // depend on the idle timeout firing within the test's own time budget.
      handler = (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.write('partial');
        res.destroy();
      };

      const result = await runWebFetch({
        provider: createLocalFetchProvider({
          resolveHost: resolveToLocalServer,
        }),
        query: { url: `${baseUrl}/dropped` },
      });

      expect(result).toContain('Web fetch failed');
    });

    it('stops reading once the body cap is reached', async () => {
      const chunk = 'y'.repeat(1000);
      // Far more than the cap, in chunks, and then the server is done: the body
      // is bounded by the reader, not by the server's willingness to stop.
      handler = (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        for (let index = 0; index < 500; index += 1) {
          res.write(chunk);
        }
        res.end();
      };

      const result = await runWebFetch({
        provider: createLocalFetchProvider({
          maxContentLength: 2000,
          resolveHost: resolveToLocalServer,
        }),
        query: { url: `${baseUrl}/huge` },
      });

      // The cap truncated the body instead of buffering all ~500 KB of it.
      expect(result.length).toBeLessThan(5000);
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

  describe('tool name normalization', () => {
    it('collapses the spellings upstream uses for the same tool', () => {
      // The wire format is snake_case, but the model echoes the call back in
      // whatever casing it prefers, so every spelling has to compare equal.
      const spellings = [
        'web_fetch',
        'WebFetch',
        'webFetch',
        'Web Fetch',
        'web-fetch',
        '  WEB_FETCH  ',
      ];

      for (const spelling of spellings) {
        expect(normalizeToolName(spelling)).toBe('webfetch');
      }

      expect(normalizeToolName('web_fetch_20250910')).toBe(
        normalizeToolName('WebFetch_20250910'),
      );
    });

    it('keeps distinct tools distinct', () => {
      expect(normalizeToolName('web_fetch')).not.toBe(
        normalizeToolName('web_search'),
      );
      expect(normalizeToolName('WebFetch')).not.toBe(
        normalizeToolName('WebSearch'),
      );
    });
  });

  describe('server tool marker', () => {
    it('ignores non-object values', () => {
      expect(isMarkedServerTool(null)).toBe(false);
      expect(isMarkedServerTool('nope')).toBe(false);
      expect(stripServerToolMarker('plain')).toBe('plain');
    });
  });

  describe('responses provenance', () => {
    it('marks a translated server tool so it can be stripped later', () => {
      const translated = translateResponsesToolsToChat([
        { type: 'web_fetch_20250910', name: 'web_fetch' },
      ]) as Array<Record<string, unknown>>;

      // The declaration becomes a plain function for upstream, so the marker is
      // the only surviving evidence that the client asked for a server tool.
      expect(translated[0]?.function).toMatchObject({ name: 'web_fetch' });
      expect(isMarkedServerTool(translated[0])).toBe(true);
    });

    it('does not mark a client-declared function of the same name', () => {
      const translated = translateResponsesToolsToChat([
        { type: 'function', name: 'web_fetch', parameters: { type: 'object' } },
      ]) as Array<Record<string, unknown>>;

      expect(isMarkedServerTool(translated[0])).toBe(false);
    });

    it('passes through a translated server tool when fetch is passthrough', async () => {
      await updateSettings({
        CODEBUDDY_WEB_FETCH_BACKEND: 'passthrough',

        CODEBUDDY_WEB_SEARCH_BACKEND: 'searxng',
      });

      const translated = translateResponsesToolsToChat([
        { type: 'web_fetch_20250910', name: 'web_fetch' },
      ]);

      const result = await executeWebSearchLoop({
        body: {
          messages: [{ content: 'hi', role: 'user' }],
          tools: translated as unknown[],
        } as ChatRequestBody,
        callUpstream: async () =>
          makeJsonResponse({
            choices: [
              { finish_reason: 'stop', message: { content: 'No tools.' } },
            ],
          }),
      });

      expect(result?.body.tools).toEqual([
        expect.objectContaining({
          type: 'function',
          function: expect.objectContaining({ name: 'web_fetch' }),
        }),
      ]);
      expect(isMarkedServerTool(result?.body.tools?.[0])).toBe(false);
    });

    it('leaves a client-declared web_fetch function alone when a backend is set', async () => {
      // The backend setting chooses who runs the *proxy's* tool, not whether
      // the proxy may take over one the client declared. A client that ships
      // its own `web_fetch` keeps resolving it — otherwise picking a backend
      // would silently disable a capability the client asked for.
      //
      // The client's own parameters are the proof: the proxy's definition has
      // `properties.url`, the client's here is `{ type: 'object' }`.
      await updateSettings({
        CODEBUDDY_WEB_FETCH_BACKEND: 'codebuddy2api',
        CODEBUDDY_WEB_SEARCH_BACKEND: 'passthrough',
      });

      const result = await executeWebSearchLoop({
        body: {
          messages: [{ content: 'hi', role: 'user' }],
          tools: [
            {
              type: 'function',
              function: {
                name: 'web_fetch',
                parameters: { type: 'object' },
              },
            },
          ],
        } as ChatRequestBody,
        callUpstream: async () =>
          makeJsonResponse({
            choices: [
              { finish_reason: 'stop', message: { content: 'No tools.' } },
            ],
          }),
      });

      // Nothing matched a server-tool declaration, so the loop declines to
      // touch the request at all.
      expect(result).toBeNull();
    });

    it('keeps a client function of the same name when fetch cannot run', async () => {
      await updateSettings({
        CODEBUDDY_WEB_FETCH_BACKEND: 'passthrough',

        CODEBUDDY_WEB_SEARCH_BACKEND: 'searxng',
      });

      const result = await executeWebSearchLoop({
        body: {
          messages: [{ content: 'hi', role: 'user' }],
          tools: [
            {
              type: 'function',
              function: {
                name: 'web_fetch',
                parameters: { type: 'object' },
              },
            },
          ],
        } as ChatRequestBody,
        callUpstream: async () =>
          makeJsonResponse({
            choices: [
              { finish_reason: 'stop', message: { content: 'No tools.' } },
            ],
          }),
      });

      // Nothing matched a server-tool declaration, so the loop declines to
      // touch the request at all — the client's own function is left exactly as
      // sent rather than being rewritten or dropped.
      expect(result).toBeNull();
    });

    it('never forwards the marker upstream', async () => {
      process.env.SEARXNG_URL = 'https://searx.test';
      resetWebSearchProviders();
      await updateSettings({
        CODEBUDDY_WEB_SEARCH_BACKEND: 'searxng',
      });

      const translated = translateResponsesToolsToChat([
        { type: 'web_search_preview' },
        { type: 'keep', name: 'keep' },
      ]);

      let forwarded: unknown[] | undefined;
      await executeWebSearchLoop({
        body: {
          messages: [{ content: 'hi', role: 'user' }],
          tools: translated as unknown[],
        } as ChatRequestBody,
        callUpstream: async (loopBody) => {
          forwarded = loopBody.tools;

          return makeJsonResponse({
            choices: [{ finish_reason: 'stop', message: { content: 'ok' } }],
          });
        },
      });

      expect((forwarded ?? []).some((tool) => isMarkedServerTool(tool))).toBe(
        false,
      );

      delete process.env.SEARXNG_URL;
      resetWebSearchProviders();
    });
  });

  describe('settings', () => {
    it('runs search by default but leaves web fetch to the client', async () => {
      const config = await getActiveConfig();

      expect(config.CODEBUDDY_WEB_SEARCH_BACKEND).toBe('searxng');
      expect(config.CODEBUDDY_WEB_FETCH_BACKEND).toBe('passthrough');

      // Search stays on its historical default; fetch defaults to the client
      // because a deployment has no basis for choosing a fetch backend itself.
      await expect(isWebSearchEnabled()).resolves.toBe(true);
      await expect(isWebFetchEnabled()).resolves.toBe(false);
    });

    it('is enabled by choosing a backend', async () => {
      await updateSettings({ CODEBUDDY_WEB_FETCH_BACKEND: 'codebuddy2api' });

      await expect(isWebFetchEnabled()).resolves.toBe(true);

      await updateSettings({ CODEBUDDY_WEB_FETCH_BACKEND: 'passthrough' });

      await expect(isWebFetchEnabled()).resolves.toBe(false);
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
    /**
     * A `web_fetch` declaration as it arrives from a client: an Anthropic
     * server-tool type run through the Responses translator, which is what
     * marks it as provider-executed. Declaring the proxy's own definition
     * directly would skip that step and arrive unmarked — indistinguishable
     * from a tool the client owns.
     */
    const translatedFetchTools = (): unknown[] =>
      translateResponsesToolsToChat([
        { type: 'web_fetch_20250910', name: 'web_fetch' },
      ]) ?? [];

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
        CODEBUDDY_WEB_FETCH_BACKEND: 'codebuddy2api',
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
        tools: translatedFetchTools(),
      });

      const payload = (await response.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      expect(payload.choices[0]?.message.content).toBe('Fetched.');
      expect(call).toBe(2);
    });

    it('executes a fetch the model echoes back as WebFetch', async () => {
      // Regression guard: upstream returns the call as `WebFetch`, not
      // `web_fetch`. An exact name match missed it, so the call was neither
      // executed nor taken over — it was handed straight back to the client
      // unresolved, and the fetch silently never happened.
      await updateSettings({
        CODEBUDDY_WEB_FETCH_BACKEND: 'codebuddy2api',
        CODEBUDDY_WEB_SEARCH_BACKEND: 'passthrough',
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
                              name: 'WebFetch',
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
        tools: translatedFetchTools(),
      });

      const payload = (await response.json()) as {
        choices: Array<{ message: { content: string } }>;
      };

      // A second upstream call means the tool ran and its result was folded
      // back in. Before the fix the loop broke on the first response and
      // returned the unresolved call, so this was 1.
      expect(payload.choices[0]?.message.content).toBe('Fetched.');
      expect(call).toBe(2);
    });

    it('executes a search the model echoes back as WebSearch', async () => {
      process.env.SEARXNG_URL = 'https://searx.test';
      resetWebSearchProviders();
      await updateSettings({
        CODEBUDDY_WEB_FETCH_BACKEND: 'passthrough',
        CODEBUDDY_WEB_SEARCH_BACKEND: 'searxng',
      });

      let call = 0;
      let searched = 0;
      const response = await runOnce({
        fetchImpl: async (...args: unknown[]) => {
          const url = String(args[0]);

          if (url.includes('searx.test')) {
            searched += 1;

            return makeJsonResponse({
              results: [
                {
                  content: 'A snippet',
                  title: 'Docs',
                  url: 'https://docs.test',
                },
              ],
            });
          }

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
                              arguments: '{"query":"latest news"}',
                              name: 'WebSearch',
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
                      message: { content: 'Searched.' },
                    },
                  ],
                });
          }

          return makeJsonResponse({});
        },
        tools: [{ type: 'function', function: buildWebSearchToolDefinition() }],
      });

      const payload = (await response.json()) as {
        choices: Array<{ message: { content: string } }>;
      };

      expect(payload.choices[0]?.message.content).toBe('Searched.');
      expect(searched).toBe(1);
      expect(call).toBe(2);

      delete process.env.SEARXNG_URL;
      resetWebSearchProviders();
    });

    it('passes through a fetch server-tool declaration', async () => {
      await updateSettings({
        CODEBUDDY_WEB_FETCH_BACKEND: 'passthrough',
        CODEBUDDY_WEB_SEARCH_BACKEND: 'passthrough',
      });

      const callUpstream = vi.fn(async (_loopBody: ChatRequestBody) =>
        makeJsonResponse({
          choices: [
            { finish_reason: 'stop', message: { content: 'No tools.' } },
          ],
        }),
      );

      const result = await executeWebSearchLoop({
        body: {
          messages: [{ content: 'hi', role: 'user' }],
          tools: [
            { type: 'web_fetch_20250910', name: 'web_fetch' },
            { type: 'function', function: { name: 'keep_me' } },
          ],
        } as ChatRequestBody,
        callUpstream: callUpstream as never,
      });

      // Passthrough never starts the local loop; the ordinary proxy path sends
      // both tools upstream after the internal marker is removed.
      expect(callUpstream).not.toHaveBeenCalled();
      expect(result?.response).toBeNull();
      expect(result?.body.tools).toEqual([
        { type: 'web_fetch_20250910', name: 'web_fetch' },
        { type: 'function', function: { name: 'keep_me' } },
      ]);
    });

    it('drops a client-declared function it would otherwise keep once disabled', async () => {
      await updateSettings({
        CODEBUDDY_WEB_FETCH_BACKEND: 'codebuddy',

        CODEBUDDY_WEB_SEARCH_BACKEND: 'searxng',
      });

      const result = await executeWebSearchLoop({
        body: {
          messages: [{ content: 'hi', role: 'user' }],
          tools: [{ type: 'function', function: { name: 'keep_me' } }],
        } as ChatRequestBody,
        callUpstream: async () =>
          makeJsonResponse({
            choices: [
              { finish_reason: 'stop', message: { content: 'No tools.' } },
            ],
          }),
      });

      // No server tool was declared, so nothing is rewritten.
      expect(result).toBeNull();
    });

    it('withdraws server tools when the model keeps calling them', async () => {
      process.env.SEARXNG_URL = 'https://searx.test';
      resetWebSearchProviders();
      await updateSettings({
        CODEBUDDY_WEB_SEARCH_BACKEND: 'searxng',
      });
      stubFetch(async (...args: unknown[]) => {
        const url = String(args[0]);

        if (url.includes('searx.test')) {
          return makeJsonResponse({ results: [] });
        }

        return makeJsonResponse({
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                tool_calls: [
                  {
                    id: `call_${url.length}`,
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
      });

      const result = await executeWebSearchLoop({
        body: {
          messages: [{ content: 'hi', role: 'user' }],
          tools: [{ type: 'web_search_preview' }],
        } as ChatRequestBody,
        callUpstream: async () =>
          makeJsonResponse({
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
          }),
      });

      // The budget ran out, so the final call goes out with the server tool
      // withdrawn — otherwise the model would search forever.
      const payload = await readPayload(result);
      expect(payload.choices).toBeDefined();

      delete process.env.SEARXNG_URL;
      resetWebSearchProviders();
    });

    it('hands a client-declared web_fetch call back even with a backend set', async () => {
      // End-to-end companion to the declaration-level guard: the backend is
      // executable, so the only thing keeping this the client's call is the
      // declaration being client-owned. The model calls the tool, the proxy
      // must not answer it — the unresolved call goes back to the client.
      await updateSettings({
        CODEBUDDY_WEB_FETCH_BACKEND: 'codebuddy2api',
        CODEBUDDY_WEB_SEARCH_BACKEND: 'passthrough',
      });

      let upstreamCalls = 0;
      let pageFetches = 0;
      const response = await runOnce({
        fetchImpl: async (...args: unknown[]) => {
          const url = String(args[0]);

          if (url.includes('a.test/page')) {
            pageFetches += 1;

            return new Response('<html><body><p>Page body</p></body></html>', {
              headers: { 'Content-Type': 'text/html' },
              status: 200,
            });
          }

          upstreamCalls += 1;

          return makeJsonResponse({
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
          });
        },
        tools: [
          {
            type: 'function',
            function: { name: 'web_fetch', parameters: { type: 'object' } },
          },
        ],
      });

      const payload = (await response.json()) as {
        choices: Array<{ message: { tool_calls?: unknown[] } }>;
      };

      // The proxy never fetched the page and never re-asked upstream; the call
      // comes back for the client to resolve.
      expect(pageFetches).toBe(0);
      expect(upstreamCalls).toBe(1);
      expect(payload.choices[0]?.message.tool_calls).toHaveLength(1);
    });

    it('leaves a client-declared web_fetch function alone when disabled', async () => {
      await updateSettings({
        CODEBUDDY_WEB_FETCH_BACKEND: 'passthrough',

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
