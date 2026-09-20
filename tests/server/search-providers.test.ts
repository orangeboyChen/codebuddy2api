/**
 * Coverage for the search provider layer.
 *
 * The proxy-facing half of the server tools lives in `server-tools/`; this file
 * covers the half that actually goes and gets things — the backend registry,
 * the two CodeBuddy agent-tool backends, and the local fetch — plus the small
 * helpers they share.
 *
 * Nothing here touches the network. The CodeBuddy backends are driven through a
 * stubbed `fetch`, and the local fetch is driven by stubbing `node:http` /
 * `node:https` `.request`, which is the only seam it has: it deliberately
 * avoids `fetch` so it can pin the socket to an already-validated address.
 */

import dns from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';

import {
  resetWebSearchProviders,
  resolveFetchProvider,
  resolveFetchProviders,
  resolveSearchProvider,
  runWebFetch,
  runWebFetchResult,
  runWebSearch,
  runWebSearchResult,
} from '@/lib/server/search';
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
  clampInteger,
  collapse,
  formatFetchResult,
  formatSearchResults,
  MAX_SNIPPET_LENGTH,
  MAX_TITLE_LENGTH,
  readEnv,
} from '@/lib/server/search/shared';
import {
  pickCredentialToken,
  resolveCodeBuddyToken,
  withCodeBuddyToken,
  type TokenResolver,
} from '@/lib/server/search/token';
import {
  buildWebFetchToolDefinition,
  DEFAULT_FETCH_BACKENDS,
  DEFAULT_SEARCH_BACKEND,
  FETCH_BACKEND_CONFIG_KEYS,
  FETCH_BACKENDS,
  normalizeFetchBackends,
  normalizeSearchBackend,
  normalizeToolName,
  SEARCH_BACKEND_CONFIG_KEYS,
  SEARCH_BACKENDS,
  serializeFetchBackends,
  WEB_FETCH_TOOL_NAME,
} from '@/lib/server/search/tool';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

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

const TOKEN = 'agent-tool-token';
const tokenResolver: TokenResolver = async () => TOKEN;
const endpointResolver = async () => 'https://agent.test/';

/** Runs `fn` with a CodeBuddy token in scope, as a proxy request would. */
const withToken = <T>(fn: () => Promise<T>): Promise<T> =>
  withCodeBuddyToken(tokenResolver, fn);

const makeJsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const makeTextResponse = (text: string, status = 200): Response =>
  new Response(text, { status });

interface FetchCall {
  init: RequestInit;
  url: string;
}

/** Stubs `fetch`, returning a recorder for the calls the backend made. */
const stubFetch = (
  implementation: (url: string, init: RequestInit) => Promise<Response>,
): { calls: FetchCall[] } => {
  const calls: FetchCall[] = [];
  const mock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const requestInit = (init ?? {}) as RequestInit;
      calls.push({ init: requestInit, url });

      return implementation(url, requestInit);
    },
  );
  vi.stubGlobal('fetch', mock);

  return { calls };
};

const stubJsonFetch = (
  payload: unknown,
  status = 200,
): { calls: FetchCall[] } =>
  stubFetch(async () => makeJsonResponse(payload, status));

const readJsonBody = (call: FetchCall): Record<string, unknown> =>
  JSON.parse(String(call.init.body)) as Record<string, unknown>;

const readHeaders = (call: FetchCall): Headers =>
  new Headers(call.init.headers as HeadersInit);

// -- Fake `node:http` / `node:https` transport ------------------------------

type LookupCallback = (
  error: Error | null,
  address: string | Array<{ address: string; family: number }>,
  family?: number,
) => void;

type PinnedLookup = (
  hostname: string,
  options: { all?: boolean },
  callback: LookupCallback,
) => void;

interface PinnedRequestOptions {
  headers?: Record<string, string>;
  host?: string;
  lookup?: PinnedLookup;
  method?: string;
  path?: string;
  port?: number;
  servername?: string;
}

interface FakeRequest {
  destroy: () => void;
  emitError: (error: unknown) => void;
  end: () => void;
  on: (event: string, listener: (error: unknown) => void) => FakeRequest;
}

interface FakeResponse extends EventEmitter {
  destroy: (error?: Error) => void;
  headers: Record<string, string | string[] | undefined>;
  idleTimeoutListener: (() => void) | null;
  resume: () => void;
  setTimeout: (ms: number, listener: () => void) => FakeResponse;
  statusCode: number | undefined;
}

const createFakeRequest = (): FakeRequest => {
  const listeners = new Map<string, Array<(error: unknown) => void>>();
  const request: FakeRequest = {
    destroy: () => undefined,
    // Deferred, because `requestPinned` registers its listener *after*
    // `request` is handed back — a socket error never arrives that early.
    emitError: (error) => {
      setTimeout(() => {
        for (const listener of listeners.get('error') ?? []) {
          listener(error);
        }
      }, 0);
    },
    end: () => undefined,
    on: (event, listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);

      return request;
    },
  };

  return request;
};

const createFakeResponse = (
  options: {
    headers?: Record<string, string | string[] | undefined>;
    statusCode?: number | undefined;
  } = {},
): FakeResponse => {
  const response = new EventEmitter() as unknown as FakeResponse;
  response.headers = options.headers ?? {};
  // A test may pass `statusCode: undefined` on purpose: that is what a
  // response carrying no status line looks like to the reader.
  response.statusCode = 'statusCode' in options ? options.statusCode : 200;
  response.idleTimeoutListener = null;
  // Matches `IncomingMessage`: destroying with an error surfaces it on the
  // stream, which is how a stalled body reaches the reader.
  response.destroy = (error?: Error) => {
    if (error) response.emit('error', error);
  };
  response.resume = () => undefined;
  response.setTimeout = (_ms: number, listener: () => void) => {
    response.idleTimeoutListener = listener;

    return response;
  };

  return response;
};

interface RespondOptions {
  body?: string;
  /** `false` leaves the body open, as a server that stalls mid-stream does. */
  endStream?: boolean;
  headers?: Record<string, string | string[] | undefined>;
  statusCode?: number | undefined;
}

interface TransportHandlerContext {
  /** Zero-based index of this request within one provider call. */
  call: number;
  options: PinnedRequestOptions;
  request: FakeRequest;
  respond: (options?: RespondOptions) => FakeResponse;
}

interface TransportCall {
  options: PinnedRequestOptions;
  request: FakeRequest;
}

/**
 * Replaces `http.request` / `https.request`.
 *
 * The handler decides what each request sees; `respond` schedules the response
 * for the next tick, because a synchronous callback would run before
 * `requestPinned` installs its own timeout.
 */
const installTransport = (
  handler: (context: TransportHandlerContext) => void,
): TransportCall[] => {
  const calls: TransportCall[] = [];

  const implementation = (
    options: PinnedRequestOptions,
    callback: (response: FakeResponse) => void,
  ): FakeRequest => {
    const request = createFakeRequest();
    const call = calls.length;
    calls.push({ options, request });

    handler({
      call,
      options,
      request,
      respond: (options: RespondOptions = {}) => {
        const response = createFakeResponse({
          headers: options.headers ?? {},
          // `undefined` is meaningful: it is what a response with no status
          // line looks like to the reader.
          statusCode: 'statusCode' in options ? options.statusCode : 200,
        });

        setTimeout(() => {
          callback(response);

          if (options.body) {
            response.emit('data', Buffer.from(options.body));
          }

          if (options.endStream ?? true) {
            response.emit('end');
          }
        }, 0);

        return response;
      },
    });

    return request;
  };

  vi.spyOn(http, 'request').mockImplementation(
    implementation as unknown as typeof http.request,
  );
  vi.spyOn(https, 'request').mockImplementation(
    implementation as unknown as typeof https.request,
  );

  return calls;
};

/** A resolver answering with a public address, as ordinary DNS would. */
const publicResolver: HostResolver = async () => ['93.184.216.34'];

/** Lets the transport's scheduled response arrive. */
const tick = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 5));

/** Drains pending timers until `done`, so a test cannot leak into the next. */
const settle = async (done: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 200 && !done(); attempt += 1) {
    await tick();
  }
};

/**
 * Stops the local fallback before it opens a socket.
 *
 * The CodeBuddy backend always starts a local fetch alongside the endpoint and
 * abandons it when the endpoint wins, so a test of the endpoint alone still has
 * to account for that attempt. Answering with a private address makes it fail
 * at the address check — no DNS, no transport stub, nothing left in flight.
 */
const blockedResolver: HostResolver = async () => ['127.0.0.1'];

const trustedResolver: HostResolver = Object.assign(async () => ['10.0.0.5'], {
  trusted: true,
});

// ---------------------------------------------------------------------------
// Backend selection and tool definitions
// ---------------------------------------------------------------------------

describe('search tool definitions and backend names', () => {
  describe('normalizeSearchBackend', () => {
    it('keeps the known engines', () => {
      expect(normalizeSearchBackend('codebuddy')).toBe('codebuddy');
      expect(normalizeSearchBackend('searxng')).toBe('searxng');
      expect(normalizeSearchBackend('duckduckgo')).toBe('duckduckgo');
      expect(normalizeSearchBackend('brave')).toBe('brave');
      expect(normalizeSearchBackend('tavily')).toBe('tavily');
      expect(normalizeSearchBackend('serper')).toBe('serper');
      expect(normalizeSearchBackend('bing')).toBe('bing');
      expect(normalizeSearchBackend('exa')).toBe('exa');
    });

    it('ignores case and surrounding whitespace', () => {
      expect(normalizeSearchBackend('  CodeBuddy ')).toBe('codebuddy');
      expect(normalizeSearchBackend('SEARXNG')).toBe('searxng');
      expect(normalizeSearchBackend(' DuckDuckGo ')).toBe('duckduckgo');
    });

    it('maps the retired passthrough onto the default engine', () => {
      // `passthrough` (and the `none` it was renamed from) no longer exists, so
      // an upgraded deployment lands on the default rather than on nothing.
      expect(normalizeSearchBackend('none')).toBe(DEFAULT_SEARCH_BACKEND);
      expect(normalizeSearchBackend('passthrough')).toBe(
        DEFAULT_SEARCH_BACKEND,
      );
    });

    it('falls back to the default for a backend only fetch knows', () => {
      // `local` renames to `codebuddy2api`, which is not a search backend.
      expect(normalizeSearchBackend('local')).toBe(DEFAULT_SEARCH_BACKEND);
      expect(normalizeSearchBackend('codebuddy2api')).toBe(
        DEFAULT_SEARCH_BACKEND,
      );
    });

    it('falls back to the default for unknown, empty, and missing values', () => {
      expect(normalizeSearchBackend('bogus')).toBe('searxng');
      expect(normalizeSearchBackend('')).toBe('searxng');
      expect(normalizeSearchBackend(null)).toBe('searxng');
      expect(normalizeSearchBackend(undefined)).toBe('searxng');
      expect(normalizeSearchBackend(42)).toBe('searxng');
    });
  });

  describe('normalizeFetchBackends', () => {
    it('keeps the known backends', () => {
      expect(normalizeFetchBackends('codebuddy')).toEqual(['codebuddy']);
      expect(normalizeFetchBackends('codebuddy2api')).toEqual([
        'codebuddy2api',
      ]);
      expect(normalizeFetchBackends('browserable')).toEqual(['browserable']);
      expect(normalizeFetchBackends('jina')).toEqual(['jina']);
    });

    it('reads a multi-selection in the order it was made', () => {
      // Order is the fallback order, so it must survive the round trip through
      // the console's comma-separated value.
      expect(normalizeFetchBackends('jina,codebuddy2api')).toEqual([
        'jina',
        'codebuddy2api',
      ]);
      expect(normalizeFetchBackends(['browserable', 'jina'])).toEqual([
        'browserable',
        'jina',
      ]);
    });

    it('treats a selection made only of `none` as off', () => {
      expect(normalizeFetchBackends('none')).toEqual([]);
      expect(normalizeFetchBackends('none,none')).toEqual([]);
      expect(normalizeFetchBackends(['none', 'none'])).toEqual([]);
      // A hand-edited value naming a backend is honoured, not disabled.
      expect(normalizeFetchBackends('jina,none')).toEqual(['jina']);
      expect(normalizeFetchBackends('none,jina')).toEqual(['jina']);
    });

    it('drops duplicates and unknown names', () => {
      expect(normalizeFetchBackends('jina,jina,codebuddy2api')).toEqual([
        'jina',
        'codebuddy2api',
      ]);
      expect(normalizeFetchBackends('jina,searxng')).toEqual(['jina']);
    });

    it('renames the legacy backends', () => {
      expect(normalizeFetchBackends('local')).toEqual(['codebuddy2api']);
    });

    it('ignores case and surrounding whitespace', () => {
      expect(normalizeFetchBackends(' Local ')).toEqual(['codebuddy2api']);
      expect(normalizeFetchBackends('CODEBUDDY')).toEqual(['codebuddy']);
    });

    it('treats the legacy `none` as an empty chain, not as the default', () => {
      // `none` always meant "never run this tool", so it still means that.
      expect(normalizeFetchBackends('none')).toEqual([]);
    });

    it('falls back to the default for the retired passthrough', () => {
      expect(normalizeFetchBackends('passthrough')).toEqual(
        DEFAULT_FETCH_BACKENDS,
      );
    });

    it('falls back to the default for an empty selection', () => {
      expect(normalizeFetchBackends('')).toEqual(DEFAULT_FETCH_BACKENDS);
      expect(normalizeFetchBackends(null)).toEqual(DEFAULT_FETCH_BACKENDS);
      expect(normalizeFetchBackends(undefined)).toEqual(DEFAULT_FETCH_BACKENDS);
    });
  });

  it('exposes the backend lists the console offers', () => {
    expect(SEARCH_BACKENDS).toEqual([
      'codebuddy',
      'searxng',
      'duckduckgo',
      'brave',
      'tavily',
      'serper',
      'bing',
      'exa',
    ]);
    expect(FETCH_BACKENDS).toEqual([
      'codebuddy',
      'codebuddy2api',
      'browserable',
      'jina',
    ]);
    expect(DEFAULT_SEARCH_BACKEND).toBe('searxng');
    expect(DEFAULT_FETCH_BACKENDS).toEqual(['codebuddy2api']);
    // No passthrough: a server tool is executed here or withdrawn, never left
    // for a client that has no way to resolve it.
    expect(SEARCH_BACKENDS).not.toContain('passthrough');
    expect(FETCH_BACKENDS).not.toContain('passthrough');
  });

  it('lists the settings each backend needs', () => {
    expect(SEARCH_BACKEND_CONFIG_KEYS.searxng).toEqual([
      'CODEBUDDY_SEARXNG_URL',
      'CODEBUDDY_SEARXNG_API_KEY',
    ]);
    expect(SEARCH_BACKEND_CONFIG_KEYS.codebuddy).toEqual([]);
    expect(FETCH_BACKEND_CONFIG_KEYS.browserable).toEqual([
      'CODEBUDDY_BROWSERABLE_URL',
      'CODEBUDDY_BROWSERABLE_API_KEY',
    ]);
    expect(FETCH_BACKEND_CONFIG_KEYS.codebuddy2api).toEqual([]);
    for (const backend of SEARCH_BACKENDS) {
      expect(SEARCH_BACKEND_CONFIG_KEYS[backend]).toBeDefined();
    }
    for (const backend of FETCH_BACKENDS) {
      expect(FETCH_BACKEND_CONFIG_KEYS[backend]).toBeDefined();
    }
  });

  it('declares web_fetch with a required url and an optional prompt', () => {
    const tool = buildWebFetchToolDefinition();

    expect(tool.name).toBe(WEB_FETCH_TOOL_NAME);
    expect(tool.name).toBe('web_fetch');
    expect(tool.parameters).toMatchObject({
      properties: {
        prompt: { type: 'string' },
        url: { type: 'string' },
      },
      required: ['url'],
      type: 'object',
    });
    // The description has to draw the line against search, or a model reaches
    // for fetch to look things up.
    expect(tool.description).toContain('search for that instead');
  });

  it('compares tool names without case, separators, or spaces', () => {
    expect(normalizeToolName('web_fetch')).toBe('webfetch');
    expect(normalizeToolName('WebFetch')).toBe('webfetch');
    expect(normalizeToolName(' Web Fetch ')).toBe('webfetch');
    expect(normalizeToolName('web-fetch')).toBe('webfetch');
    expect(normalizeToolName('WEB_SEARCH')).toBe('websearch');
    expect(normalizeToolName('web_search_20260209')).toBe(
      normalizeToolName('websearch20260209'),
    );
  });
});

// ---------------------------------------------------------------------------
// Shared rendering helpers
// ---------------------------------------------------------------------------

describe('search result rendering helpers', () => {
  describe('readEnv', () => {
    afterEach(() => {
      delete process.env.TEST_SEARCH_ENV;
    });

    it('trims the value of a set variable', () => {
      process.env.TEST_SEARCH_ENV = '  https://searx.test/  ';

      expect(readEnv('TEST_SEARCH_ENV')).toBe('https://searx.test/');
    });

    it('returns an empty string when the variable is absent', () => {
      expect(readEnv('TEST_SEARCH_ENV')).toBe('');
    });
  });

  describe('clampInteger', () => {
    it('uses the fallback for missing or unparseable input', () => {
      expect(clampInteger(undefined, 5, 1, 10)).toBe(5);
      expect(clampInteger('', 5, 1, 10)).toBe(5);
      expect(clampInteger('  ', 5, 1, 10)).toBe(5);
      expect(clampInteger('not-a-number', 5, 1, 10)).toBe(5);
    });

    it('parses a value inside the range', () => {
      expect(clampInteger('7', 5, 1, 10)).toBe(7);
      expect(clampInteger(' 3 ', 5, 1, 10)).toBe(3);
    });

    it('clamps a value outside the range', () => {
      expect(clampInteger('99', 5, 1, 10)).toBe(10);
      expect(clampInteger('-4', 5, 1, 10)).toBe(1);
    });
  });

  describe('collapse', () => {
    it('collapses runs of whitespace', () => {
      expect(collapse('  one\n\n two \t three ', 100)).toBe('one two three');
    });

    it('truncates to the limit and marks the cut', () => {
      expect(collapse('abcdefghij', 5)).toBe('abcd…');
      expect(collapse('abcdefghij', 5)).toHaveLength(5);
    });

    it('leaves text at or under the limit untouched', () => {
      expect(collapse('abcde', 5)).toBe('abcde');
    });
  });

  describe('formatSearchResults', () => {
    it('tells the model to answer from memory when nothing came back', () => {
      const text = formatSearchResults('nothing here', []);

      expect(text).toContain('returned no results');
      expect(text).toContain('nothing here');
    });

    it('renders one result in the singular', () => {
      const text = formatSearchResults('q', [
        { title: 'Only', url: 'https://a' },
      ]);

      expect(text).toContain('(1 result)');
      expect(text).toContain('1. Only');
      expect(text).toContain('URL: https://a');
    });

    it('renders several results with their snippets', () => {
      const text = formatSearchResults('q', [
        { content: 'First body', title: 'First', url: 'https://a' },
        { content: 'Second body', title: 'Second', url: 'https://b' },
      ]);

      expect(text).toContain('(2 results)');
      expect(text).toContain('1. First');
      expect(text).toContain('2. Second');
      expect(text).toContain('First body');
      expect(text).toContain('Second body');
      expect(text).toContain('Cite the URL');
    });

    it('substitutes placeholders for missing fields', () => {
      const text = formatSearchResults('q', [{}, { title: '  ' }]);

      expect(text).toContain('1. (untitled)');
      expect(text).toContain('2. (untitled)');
      // Neither entry has a URL, so no citation line is emitted.
      expect(text).not.toContain('URL:');
    });
  });

  describe('formatFetchResult', () => {
    it('names the source url', () => {
      const text = formatFetchResult({
        content: 'Body',
        url: 'https://a.test',
      });

      expect(text).toContain('Web fetch result for https://a.test:');
      expect(text).toContain('Body');
    });

    it('includes the requested focus when the model gave one', () => {
      const text = formatFetchResult({
        content: 'Body',
        prompt: 'the pricing tiers',
        url: 'https://a.test',
      });

      expect(text).toContain('Requested focus: the pricing tiers');
    });

    it('omits the focus line when there is no prompt', () => {
      const text = formatFetchResult({
        content: 'Body',
        url: 'https://a.test',
      });

      expect(text).not.toContain('Requested focus');
    });

    it('clamps an over-long prompt to the title limit', () => {
      const text = formatFetchResult({
        content: 'Body',
        prompt: 'x'.repeat(MAX_TITLE_LENGTH + 50),
        url: 'https://a.test',
      });

      expect(text).toContain('…');
      expect(text).not.toContain('x'.repeat(MAX_TITLE_LENGTH + 1));
    });
  });

  it('bounds titles and snippets', () => {
    expect(MAX_TITLE_LENGTH).toBe(200);
    expect(MAX_SNIPPET_LENGTH).toBe(800);
  });
});

// ---------------------------------------------------------------------------
// Token plumbing
// ---------------------------------------------------------------------------

const STORED_TOKEN = 'stored-bearer-token';

/**
 * The credential the store hands back, mutable so one test can empty it.
 *
 * Hoisted because the module factory below runs before anything else in this
 * file is initialised.
 */
const store = vi.hoisted(() => ({
  credential: { data: { bearer_token: 'stored-bearer-token' } } as {
    data: Record<string, unknown>;
  } | null,
}));

/**
 * Stands in for credential storage.
 *
 * `resolveCodeBuddyToken` falls back to an unscoped credential lookup when no
 * token is in scope, so the fallback is the only path that reads storage — and
 * it is reachable outside a proxy turn. Stubbing it here keeps that branch
 * deterministic without a credential file on disk.
 */
vi.mock('@/lib/server/domain/credentials', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveCredentialForRequest: async () => store.credential,
}));

describe('CodeBuddy token plumbing', () => {
  afterEach(() => {
    store.credential = { data: { bearer_token: STORED_TOKEN } };
  });
  describe('pickCredentialToken', () => {
    it('prefers the bearer token', () => {
      expect(
        pickCredentialToken({
          access_token: 'access',
          bearer_token: 'bearer',
        }),
      ).toBe('bearer');
    });

    it('falls through a blank bearer token to the access token', () => {
      expect(
        pickCredentialToken({ access_token: 'access', bearer_token: '' }),
      ).toBe('access');
      expect(
        pickCredentialToken({ access_token: 'access', bearer_token: '   ' }),
      ).toBe('access');
    });

    it('returns null when both are blank or absent', () => {
      expect(
        pickCredentialToken({ access_token: '  ', bearer_token: '' }),
      ).toBeNull();
      expect(pickCredentialToken({})).toBeNull();
      expect(pickCredentialToken({ bearer_token: null })).toBeNull();
    });

    it('stringifies and trims non-string values', () => {
      expect(pickCredentialToken({ bearer_token: 1234 })).toBe('1234');
      expect(pickCredentialToken({ bearer_token: '  padded  ' })).toBe(
        'padded',
      );
    });
  });

  describe('withCodeBuddyToken', () => {
    it('makes the token visible to the resolver inside the scope', async () => {
      const seen = await withCodeBuddyToken(
        async () => 'scoped',
        async () => resolveCodeBuddyToken(),
      );

      expect(seen).toBe('scoped');
    });

    it('keeps the token visible across an await', async () => {
      const seen = await withCodeBuddyToken(
        async () => 'scoped',
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));

          return resolveCodeBuddyToken();
        },
      );

      expect(seen).toBe('scoped');
    });

    it('returns the value the scope produced', async () => {
      await expect(
        withCodeBuddyToken(
          async () => 'scoped',
          async () => 'done',
        ),
      ).resolves.toBe('done');
    });

    it('falls back to stored credentials outside the scope', async () => {
      // No token is in scope, so the resolver reads the credential store —
      // and it must not see the token of a scope that is not running.
      await expect(resolveCodeBuddyToken()).resolves.toBe(STORED_TOKEN);
    });

    it('returns null when no credential is stored either', async () => {
      store.credential = null;

      await expect(resolveCodeBuddyToken()).resolves.toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe('search provider registry', () => {
  beforeEach(() => {
    clearSearxngEnv();
  });

  afterEach(() => {
    clearSearxngEnv();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('resolveSearchProvider', () => {
    it('builds the CodeBuddy backend', () => {
      expect(
        resolveSearchProvider('codebuddy', {
          resolveEndpoint: endpointResolver,
        })?.id,
      ).toBe('codebuddy');
    });

    it('builds a fresh CodeBuddy backend per call', () => {
      // A cached backend would freeze the endpoint it was built with.
      const first = resolveSearchProvider('codebuddy', {
        resolveEndpoint: endpointResolver,
      });
      const second = resolveSearchProvider('codebuddy', {
        resolveEndpoint: endpointResolver,
      });

      expect(first).not.toBe(second);
    });

    it('builds the DuckDuckGo backend, which needs no credential', () => {
      expect(resolveSearchProvider('duckduckgo')?.id).toBe('duckduckgo');
    });

    it('builds the SearXNG backend from the console setting', () => {
      const provider = resolveSearchProvider('searxng', {
        search: { searxngUrl: 'https://searx.test/' },
      });

      expect(provider?.id).toBe('searxng');
    });

    it('builds the SearXNG backend from the environment when the setting is empty', () => {
      process.env.SEARXNG_URL = 'https://searx.test/';
      resetWebSearchProviders();

      expect(resolveSearchProvider('searxng')?.id).toBe('searxng');
    });

    it('returns null for SearXNG when no instance is configured', () => {
      expect(resolveSearchProvider('searxng')).toBeNull();
    });

    it('builds the keyed engines once their key is entered', () => {
      const engines = {
        brave: 'brave-key',
        bing: 'bing-key',
        exa: 'exa-key',
        serper: 'serper-key',
        tavily: 'tavily-key',
      } as const;

      for (const [engine, key] of Object.entries(engines)) {
        expect(
          resolveSearchProvider(engine, {
            search: { [`${engine}ApiKey`]: key },
          })?.id,
        ).toBe(engine);
      }
    });

    it('resolves nothing when the tool is switched off', () => {
      // `none` is the value a deployment saved before this table existed, and
      // the console offers it: it must stay off after upgrading. SearXNG is
      // configured here, so only the off switch can produce a null.
      process.env.SEARXNG_URL = 'https://searx.test';
      resetWebSearchProviders();

      try {
        expect(resolveSearchProvider('searxng')?.id).toBe('searxng');
        expect(resolveSearchProvider('none')).toBeNull();
        expect(resolveSearchProvider('NONE', { search: {} })).toBeNull();
      } finally {
        delete process.env.SEARXNG_URL;
        resetWebSearchProviders();
      }
    });

    it('returns null for a keyed engine whose key was never entered', () => {
      // Advertising a tool the deployment cannot run is worse than not
      // advertising it, so the engine declines instead.
      expect(resolveSearchProvider('brave')).toBeNull();
      expect(resolveSearchProvider('bing', { search: {} })).toBeNull();
      expect(
        resolveSearchProvider('tavily', { search: { tavilyApiKey: '  ' } }),
      ).toBeNull();
    });

    it('defaults to SearXNG for an unknown or missing backend', () => {
      process.env.SEARXNG_URL = 'https://searx.test/';
      resetWebSearchProviders();

      expect(resolveSearchProvider(null)?.id).toBe('searxng');
      expect(resolveSearchProvider(undefined)?.id).toBe('searxng');
      expect(resolveSearchProvider('bogus')?.id).toBe('searxng');
    });

    it('builds SearXNG per call, so a changed address takes effect at once', () => {
      const first = resolveSearchProvider('searxng', {
        search: { searxngUrl: 'https://searx.test/' },
      });

      expect(
        resolveSearchProvider('searxng', {
          search: { searxngUrl: 'https://searx.test/' },
        }),
      ).not.toBe(first);
    });
  });

  describe('resolveFetchProvider', () => {
    it('builds the local backend and caches it', () => {
      const first = resolveFetchProvider('codebuddy2api');

      expect(first?.id).toBe('codebuddy2api');
      expect(resolveFetchProvider('local')).toBe(first);
    });

    it('rebuilds the local backend after a reset', () => {
      const first = resolveFetchProvider('local');
      resetWebSearchProviders();

      expect(resolveFetchProvider('local')).not.toBe(first);
    });

    it('builds the CodeBuddy backend', () => {
      expect(
        resolveFetchProvider('codebuddy', { resolveEndpoint: endpointResolver })
          ?.id,
      ).toBe('codebuddy');
    });

    it('builds the Jina backend, whose key is optional', () => {
      expect(resolveFetchProvider('jina')?.id).toBe('jina');
      expect(
        resolveFetchProvider('jina', { fetch: { jinaApiKey: 'jina-key' } })?.id,
      ).toBe('jina');
    });

    it('builds the Browserable backend once an address is entered', () => {
      expect(resolveFetchProvider('browserable')).toBeNull();

      const provider = resolveFetchProvider('browserable', {
        fetch: { browserableUrl: 'http://browser.test/' },
      });

      expect(provider?.id).toBe('browserable');
    });

    it('composes several selections into one chain, in order', () => {
      const provider = resolveFetchProvider('jina,codebuddy2api');

      expect(provider?.id).toBe('fallback(jina+codebuddy2api)');
      expect(
        resolveFetchProviders('jina,codebuddy2api').map(({ id }) => id),
      ).toEqual(['jina', 'codebuddy2api']);
    });

    it('drops a selected backend that cannot run', () => {
      // Browserable without an address is not a hop worth taking.
      expect(
        resolveFetchProviders('browserable,codebuddy2api').map(({ id }) => id),
      ).toEqual(['codebuddy2api']);
    });

    it('resolves nothing for the legacy `none`, which means off', () => {
      expect(resolveFetchProvider('none')).toBeNull();
    });

    it('falls back to the default for the retired passthrough', () => {
      expect(resolveFetchProvider('passthrough')?.id).toBe('codebuddy2api');
    });

    it('stores an empty selection as `none`, so clearing the picker turns it off', () => {
      // An empty string is indistinguishable from "never configured" and would
      // be replaced by the default on the way in.
      expect(serializeFetchBackends([])).toBe('none');
      expect(serializeFetchBackends(['jina', 'codebuddy2api'])).toBe(
        'jina,codebuddy2api',
      );
    });

    it('resolves the default when nothing is configured', () => {
      expect(resolveFetchProvider(null)?.id).toBe('codebuddy2api');
      expect(resolveFetchProvider(undefined)?.id).toBe('codebuddy2api');
      expect(resolveFetchProvider('bogus')?.id).toBe('codebuddy2api');
    });
  });

  describe('runWebSearchResult', () => {
    it('runs the supplied provider', async () => {
      const result = await runWebSearchResult({
        provider: {
          id: 'stub',
          search: async (query) => ({ content: `ok:${query}`, results: [] }),
        },
        query: 'hello',
      });

      expect(result.content).toBe('ok:hello');
      expect(result.results).toEqual([]);
    });

    it('reports an unconfigured backend instead of failing', async () => {
      // SearXNG with no instance configured resolves to no provider at all.
      await expect(
        runWebSearchResult({ backend: 'searxng', query: 'hello' }),
      ).resolves.toMatchObject({
        content: expect.stringContaining('no search backend is configured'),
        results: [],
      });
    });

    it('treats an explicit null provider as unavailable', async () => {
      await expect(
        runWebSearchResult({ provider: null, query: 'hello' }),
      ).resolves.toMatchObject({ results: [] });
    });

    it('resolves the backend when no provider is supplied', async () => {
      const { calls } = stubJsonFetch({ results: [] });

      await withToken(() =>
        runWebSearchResult({
          backend: 'codebuddy',
          query: 'hello',
          resolveEndpoint: endpointResolver,
        }),
      );

      expect(calls[0].url).toBe('https://agent.test/agenttool/v1/search');
    });

    it('turns a thrown error into text the model can act on', async () => {
      await expect(
        runWebSearchResult({
          provider: {
            id: 'boom',
            search: async () => {
              throw new Error('connection refused');
            },
          },
          query: 'hello',
        }),
      ).resolves.toMatchObject({
        content: expect.stringContaining(
          'Web search failed: connection refused',
        ),
        results: [],
      });
    });

    it('reports a timeout as a timeout', async () => {
      await expect(
        runWebSearchResult({
          provider: {
            id: 'slow',
            search: async () => {
              throw Object.assign(new Error('aborted'), { name: 'AbortError' });
            },
          },
          query: 'hello',
        }),
      ).resolves.toMatchObject({
        content: expect.stringContaining('timed out'),
      });
    });

    it('reports a non-Error rejection as an unknown failure', async () => {
      await expect(
        runWebSearchResult({
          provider: {
            id: 'weird',
            search: async () => {
              throw 'a string';
            },
          },
          query: 'hello',
        }),
      ).resolves.toMatchObject({
        content: expect.stringContaining('unknown error'),
      });
    });

    it('reports an Error with no message as an unknown failure', async () => {
      await expect(
        runWebSearchResult({
          provider: {
            id: 'silent',
            search: async () => {
              throw new Error('');
            },
          },
          query: 'hello',
        }),
      ).resolves.toMatchObject({
        content: expect.stringContaining('unknown error'),
      });
    });
  });

  it('runWebSearch returns only the text', async () => {
    await expect(
      runWebSearch({
        provider: {
          id: 'stub',
          search: async () => ({ content: 'the text', results: [] }),
        },
        query: 'hello',
      }),
    ).resolves.toBe('the text');
  });

  describe('runWebFetchResult', () => {
    it('runs the supplied provider', async () => {
      await expect(
        runWebFetchResult({
          provider: {
            fetch: async (query) => ({ content: `ok:${query.url}` }),
            id: 'stub',
          },
          query: { url: 'https://a.test' },
        }),
      ).resolves.toEqual({ content: 'ok:https://a.test' });
    });

    it('reports an unconfigured backend instead of failing', async () => {
      // Browserable with no address is dropped, leaving nothing to run.
      await expect(
        runWebFetchResult({
          backend: 'browserable',
          query: { url: 'https://a.test' },
        }),
      ).resolves.toEqual({
        content: expect.stringContaining('no web fetch backend is enabled'),
      });
    });

    it('treats an explicit null provider as unavailable', async () => {
      await expect(
        runWebFetchResult({ provider: null, query: { url: 'https://a.test' } }),
      ).resolves.toEqual({
        content: expect.stringContaining('Web fetch is unavailable'),
      });
    });

    it('resolves the backend when no provider is supplied', async () => {
      const { calls } = stubJsonFetch({ content: 'page text' });

      const result = await withToken(() =>
        runWebFetchResult({
          backend: 'codebuddy',
          // A loopback url keeps the backend's local fallback — which runs
          // alongside the endpoint and is abandoned — at the address check,
          // so it never reaches DNS.
          query: { url: 'http://127.0.0.1/internal' },
          resolveEndpoint: endpointResolver,
        }),
      );

      expect(calls[0].url).toBe('https://agent.test/agenttool/v1/webfetch');
      expect(result.content).toContain('page text');
    });

    it('turns a thrown error into text', async () => {
      await expect(
        runWebFetchResult({
          provider: {
            fetch: async () => {
              throw new Error('socket hang up');
            },
            id: 'boom',
          },
          query: { url: 'https://a.test' },
        }),
      ).resolves.toEqual({
        content: expect.stringContaining('Web fetch failed: socket hang up'),
      });
    });

    it('reports a timeout as a timeout', async () => {
      await expect(
        runWebFetchResult({
          provider: {
            fetch: async () => {
              throw Object.assign(new Error('aborted'), { name: 'AbortError' });
            },
            id: 'slow',
          },
          query: { url: 'https://a.test' },
        }),
      ).resolves.toEqual({ content: expect.stringContaining('timed out') });
    });

    it('reports a non-Error rejection as an unknown failure', async () => {
      await expect(
        runWebFetchResult({
          provider: {
            fetch: async () => {
              throw 404;
            },
            id: 'weird',
          },
          query: { url: 'https://a.test' },
        }),
      ).resolves.toEqual({ content: expect.stringContaining('unknown error') });
    });
  });

  it('runWebFetch returns only the text', async () => {
    await expect(
      runWebFetch({
        provider: {
          fetch: async () => ({ content: 'the text', url: 'https://a.test' }),
          id: 'stub',
        },
        query: { url: 'https://a.test' },
      }),
    ).resolves.toBe('the text');
  });
});

// ---------------------------------------------------------------------------
// CodeBuddy search backend
// ---------------------------------------------------------------------------

describe('CodeBuddy search provider', () => {
  const provider = (
    options: { maxResults?: number; timeoutMs?: number } = {},
  ) =>
    createCodeBuddySearchProvider({
      maxResults: options.maxResults,
      resolveEndpoint: endpointResolver,
      resolveToken: tokenResolver,
      timeoutMs: options.timeoutMs,
    });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('identifies itself', () => {
    expect(provider().id).toBe('codebuddy');
  });

  it('posts to the agent-tool search endpoint', async () => {
    const { calls } = stubJsonFetch({ results: [] });

    await provider().search('latest news');

    // The endpoint keeps a trailing slash in settings; the path is appended.
    expect(calls[0].url).toBe('https://agent.test/agenttool/v1/search');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.cache).toBe('no-store');
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it('sends the credential and the CLI headers', async () => {
    const { calls } = stubJsonFetch({ results: [] });

    await provider().search('q');
    const headers = readHeaders(calls[0]);

    expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(headers.get('content-type')).toBe('application/json;charset=UTF-8');
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('x-requested-with')).toBe('XMLHttpRequest');
  });

  it('sends the query, result count, and request type', async () => {
    const { calls } = stubJsonFetch({ results: [] });

    await provider().search('latest news');

    expect(readJsonBody(calls[0])).toEqual({
      max_results: 5,
      query: 'latest news',
      type: 'text2text',
    });
  });

  it('parses results into the shared shape', async () => {
    stubJsonFetch({
      results: [
        {
          snippet: '  Snippet   one  ',
          title: '  First  ',
          url: ' https://a.test ',
        },
        { content: 'From content', title: 'Second', url: 'https://b.test' },
        { title: 'No body', url: 'https://c.test' },
      ],
    });

    const result = await provider().search('q');

    expect(result.results).toEqual([
      { content: 'Snippet one', title: 'First', url: 'https://a.test' },
      { content: 'From content', title: 'Second', url: 'https://b.test' },
      { content: undefined, title: 'No body', url: 'https://c.test' },
    ]);
    expect(result.content).toContain('First');
    expect(result.content).toContain('Snippet one');
  });

  it('leaves a title and url it was not given undefined', async () => {
    // A hit with only a body still has to render, so the entry cannot be
    // dropped for want of a title.
    stubJsonFetch({ results: [{ snippet: 'body only' }] });

    const result = await provider().search('q');

    expect(result.results).toEqual([
      { content: 'body only', title: undefined, url: undefined },
    ]);
    expect(result.content).toContain('(untitled)');
  });

  it('drops entries that are not objects and caps the count', async () => {
    stubJsonFetch({
      results: [
        null,
        'not an object',
        7,
        ...Array.from({ length: 12 }, (_, index) => ({
          title: `Result ${index}`,
          url: `https://${index}.test`,
        })),
      ],
    });

    const result = await provider({ maxResults: 10 }).search('q');

    expect(result.results).toHaveLength(10);
    expect(result.results[0].title).toBe('Result 0');
  });

  it('clamps the requested result count', async () => {
    const zero = stubJsonFetch({ results: [] });
    await provider({ maxResults: 0 }).search('q');
    expect(readJsonBody(zero.calls[0]).max_results).toBe(1);

    const huge = stubJsonFetch({ results: [] });
    await provider({ maxResults: 99 }).search('q');
    expect(readJsonBody(huge.calls[0]).max_results).toBe(10);
  });

  it('truncates an over-long query', async () => {
    const { calls } = stubJsonFetch({ results: [] });

    await provider().search('x'.repeat(600));

    expect(readJsonBody(calls[0]).query).toHaveLength(500);
  });

  it('skips the request for a blank query', async () => {
    const { calls } = stubJsonFetch({ results: [] });

    const result = await provider().search('   ');

    expect(calls).toHaveLength(0);
    expect(result.content).toContain('without a query');
    expect(result.results).toEqual([]);
  });

  it('refuses to run without a token', async () => {
    const { calls } = stubJsonFetch({ results: [] });
    const anonymous = createCodeBuddySearchProvider({
      resolveEndpoint: endpointResolver,
      resolveToken: async () => null,
    });

    await expect(anonymous.search('q')).rejects.toThrow(
      'Authentication required',
    );
    expect(calls).toHaveLength(0);
  });

  it('treats a whitespace-only token as no token', async () => {
    const blank = createCodeBuddySearchProvider({
      resolveEndpoint: endpointResolver,
      resolveToken: async () => '   ',
    });

    await expect(blank.search('q')).rejects.toThrow('Authentication required');
  });

  it('reports an HTTP failure that carries a JSON message', async () => {
    stubJsonFetch({ code: 7, msg: 'upstream down' }, 500);

    await expect(provider().search('q')).rejects.toThrow(
      'CodeBuddy web search error: upstream down (code: 7)',
    );
  });

  it('names an unknown code when the message carries none', async () => {
    stubJsonFetch({ msg: 'upstream down' }, 500);

    await expect(provider().search('q')).rejects.toThrow(
      'CodeBuddy web search error: upstream down (code: unknown)',
    );
  });

  it('reports an HTTP failure with no usable message', async () => {
    stubJsonFetch({ code: 7 }, 502);
    await expect(provider().search('q')).rejects.toThrow('HTTP 502');

    vi.unstubAllGlobals();
    stubFetch(async () => makeTextResponse('not json', 503));
    await expect(provider().search('q')).rejects.toThrow('HTTP 503');

    vi.unstubAllGlobals();
    stubFetch(async () => makeTextResponse('', 504));
    await expect(provider().search('q')).rejects.toThrow('HTTP 504');
  });

  it('falls back to the status when the error body cannot be read', async () => {
    // A body that fails to decode must not mask the status.
    stubFetch(
      async () =>
        ({
          ok: false,
          status: 500,
          text: async () => {
            throw new Error('body already consumed');
          },
        }) as unknown as Response,
    );

    await expect(provider().search('q')).rejects.toThrow(
      'CodeBuddy web search failed with HTTP 500',
    );
  });

  it('abandons a request that outlasts the timeout', async () => {
    // The endpoint is on the critical path of a model turn, so a hanging
    // search has to fail on its own rather than wait for the socket.
    stubFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
    );

    await expect(provider({ timeoutMs: 1_000 }).search('q')).rejects.toThrow(
      'aborted',
    );
  });

  it('reports an error code in a successful response', async () => {
    stubJsonFetch({ code: 3, msg: 'bad request' });

    await expect(provider().search('q')).rejects.toThrow(
      'CodeBuddy web search error: bad request',
    );
  });

  it('names an unknown error code when no message came back', async () => {
    stubJsonFetch({ code: 3 });

    await expect(provider().search('q')).rejects.toThrow('Unknown error');
  });

  it('tolerates a payload with no results', async () => {
    stubJsonFetch({});

    const result = await provider().search('q');

    expect(result.results).toEqual([]);
    expect(result.content).toContain('returned no results');
  });

  it('tolerates a results field that is not an array', async () => {
    stubJsonFetch({ results: 'nope' });

    const result = await provider().search('q');

    expect(result.results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// CodeBuddy fetch backend
// ---------------------------------------------------------------------------

describe('CodeBuddy fetch provider', () => {
  const provider = (
    options: {
      maxContentLength?: number;
      resolveHost?: HostResolver;
      timeoutMs?: number;
    } = {},
  ) =>
    createCodeBuddyFetchProvider({
      maxContentLength: options.maxContentLength,
      resolveEndpoint: endpointResolver,
      resolveHost: options.resolveHost ?? blockedResolver,
      resolveToken: tokenResolver,
      timeoutMs: options.timeoutMs,
    });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe('normalizeFetchUrl', () => {
    it('trims the url', () => {
      expect(normalizeFetchUrl('  https://a.test/  ')).toBe('https://a.test/');
    });

    it('upgrades plain http to https', () => {
      expect(normalizeFetchUrl('http://a.test/page')).toBe(
        'https://a.test/page',
      );
    });

    it('rewrites a GitHub blob url to its raw counterpart', () => {
      expect(
        normalizeFetchUrl('https://github.com/org/repo/blob/main/README.md'),
      ).toBe('https://raw.githubusercontent.com/org/repo/main/README.md');
    });

    it('upgrades and rewrites in one pass', () => {
      expect(
        normalizeFetchUrl('http://github.com/org/repo/blob/main/a.ts'),
      ).toBe('https://raw.githubusercontent.com/org/repo/main/a.ts');
    });

    it('leaves a url that is neither plain http nor a blob alone', () => {
      expect(normalizeFetchUrl('https://a.test/blob/not-github')).toBe(
        'https://a.test/blob/not-github',
      );
      expect(normalizeFetchUrl('https://github.com/org/repo/tree/main')).toBe(
        'https://github.com/org/repo/tree/main',
      );
    });
  });

  it('identifies itself', () => {
    expect(provider().id).toBe('codebuddy');
  });

  it('posts to the agent-tool webfetch endpoint', async () => {
    const { calls } = stubJsonFetch({
      content: 'page text',
      content_type: 'text/markdown',
      url: 'https://final.test/page',
    });

    const result = await provider().fetch({ url: 'https://a.test/page' });

    expect(calls[0].url).toBe('https://agent.test/agenttool/v1/webfetch');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.cache).toBe('no-store');
    expect(readHeaders(calls[0]).get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(result.url).toBe('https://final.test/page');
    expect(result.content).toContain(
      'Web fetch result for https://final.test/page:',
    );
    expect(result.content).toContain('page text');
  });

  it('sends the extraction hint, format, and bound the CLI sends', async () => {
    const { calls } = stubJsonFetch({ content: 'page text' });

    await provider().fetch({
      prompt: ' the pricing tiers ',
      url: 'https://a.test/page',
    });

    expect(readJsonBody(calls[0])).toEqual({
      format: 'markdown',
      max_length: 100_000,
      prompt: 'the pricing tiers',
      timeout: 30,
      url: 'https://a.test/page',
    });
  });

  it('asks for the whole page when the model gives no prompt', async () => {
    const { calls } = stubJsonFetch({ content: 'page text' });

    await provider().fetch({ url: 'https://a.test/page' });

    expect(readJsonBody(calls[0]).prompt).toBe('');
  });

  it('truncates an over-long prompt', async () => {
    const { calls } = stubJsonFetch({ content: 'page text' });

    await provider().fetch({ prompt: 'p'.repeat(600), url: 'https://a.test/' });

    expect(readJsonBody(calls[0]).prompt).toHaveLength(500);
  });

  it('sends the normalized url and truncates an over-long one', async () => {
    const { calls } = stubJsonFetch({ content: 'page text' });

    await provider().fetch({
      url: `http://github.com/org/repo/blob/main/${'a'.repeat(3_000)}`,
    });

    const body = readJsonBody(calls[0]);
    expect(body.url).toHaveLength(2_048);
    expect(
      String(body.url).startsWith('https://raw.githubusercontent.com/'),
    ).toBe(true);
  });

  it('honours a configured content limit', async () => {
    const { calls } = stubJsonFetch({ content: 'x'.repeat(200) });

    const result = await provider({ maxContentLength: 10 }).fetch({
      url: 'https://a.test/',
    });

    expect(readJsonBody(calls[0]).max_length).toBe(10);
    expect(result.content).toContain('x'.repeat(10));
    expect(result.content).not.toContain('x'.repeat(11));
  });

  it('falls back to the requested url when the endpoint reports none', async () => {
    stubJsonFetch({ content: 'page text', url: '   ' });

    const result = await provider().fetch({ url: 'https://a.test/page' });

    expect(result.url).toBe('https://a.test/page');
  });

  it('skips the request for a blank url', async () => {
    const { calls } = stubJsonFetch({ content: 'page text' });

    const result = await provider().fetch({ url: '   ' });

    expect(calls).toHaveLength(0);
    expect(result.content).toContain('without a URL');
  });

  it('refuses to run without a token', async () => {
    const { calls } = stubJsonFetch({ content: 'page text' });
    const anonymous = createCodeBuddyFetchProvider({
      resolveEndpoint: endpointResolver,
      resolveHost: publicResolver,
      resolveToken: async () => '  ',
    });

    await expect(anonymous.fetch({ url: 'https://a.test/' })).rejects.toThrow(
      'Authentication required',
    );
    expect(calls).toHaveLength(0);
  });

  it('reports an HTTP failure that carries a JSON message', async () => {
    stubJsonFetch({ code: 9, msg: 'rate limited' }, 429);

    await expect(provider().fetch({ url: 'https://a.test/' })).rejects.toThrow(
      'CodeBuddy web fetch error: rate limited (code: 9)',
    );
  });

  it('reports an HTTP failure with no usable message', async () => {
    stubJsonFetch({ code: 9 }, 500);
    await expect(provider().fetch({ url: 'https://a.test/' })).rejects.toThrow(
      'HTTP 500',
    );

    vi.unstubAllGlobals();
    stubFetch(async () => makeTextResponse('not json', 502));
    await expect(provider().fetch({ url: 'https://a.test/' })).rejects.toThrow(
      'HTTP 502',
    );

    vi.unstubAllGlobals();
    stubFetch(async () => makeTextResponse('', 503));
    await expect(provider().fetch({ url: 'https://a.test/' })).rejects.toThrow(
      'HTTP 503',
    );
  });

  it('names an unknown code when the message carries none', async () => {
    stubJsonFetch({ msg: 'rate limited' }, 429);

    await expect(provider().fetch({ url: 'https://a.test/' })).rejects.toThrow(
      'CodeBuddy web fetch error: rate limited (code: unknown)',
    );
  });

  it('falls back to the status when the error body cannot be read', async () => {
    stubFetch(
      async () =>
        ({
          ok: false,
          status: 500,
          text: async () => {
            throw new Error('body already consumed');
          },
        }) as unknown as Response,
    );

    await expect(provider().fetch({ url: 'https://a.test/' })).rejects.toThrow(
      'CodeBuddy web fetch failed with HTTP 500',
    );
  });

  it('reports an error code in a successful response', async () => {
    stubJsonFetch({ code: 4, msg: 'no such page' });

    await expect(provider().fetch({ url: 'https://a.test/' })).rejects.toThrow(
      'CodeBuddy web fetch error: no such page',
    );
  });

  it('names an unknown error code when no message came back', async () => {
    stubJsonFetch({ code: 4 });

    await expect(provider().fetch({ url: 'https://a.test/' })).rejects.toThrow(
      'Unknown error',
    );
  });

  describe('resource classification', () => {
    it.each([
      { content_type: '', kind: 'text' },
      { content_type: 'text/html; charset=utf-8', kind: 'text' },
      { content_type: 'TEXT/PLAIN', kind: 'text' },
      { content_type: 'application/json', kind: 'text' },
      { content_type: 'application/xml', kind: 'text' },
      { content_type: 'application/javascript', kind: 'text' },
      { content_type: 'image/png', kind: 'binary' },
      { content_type: 'application/pdf', kind: 'binary' },
      { content_type: 'application/zip', kind: 'binary' },
      { content_type: 'application/octet-stream', kind: 'binary' },
      { content_type: 'video/mp4', kind: 'binary' },
      { content_type: 'audio/mpeg', kind: 'binary' },
    ])('treats $content_type as $kind', async ({ content_type, kind }) => {
      stubJsonFetch({ content: 'page text', content_type });

      if (kind === 'text') {
        await expect(
          provider().fetch({ url: 'https://a.test/' }),
        ).resolves.toEqual(expect.objectContaining({ url: 'https://a.test/' }));

        return;
      }

      // The endpoint's reason survives into the combined failure.
      await expect(
        provider().fetch({ url: 'https://a.test/' }),
      ).rejects.toThrow('non-text resource');
    });

    it('treats a missing content type as text', async () => {
      stubJsonFetch({ content: 'page text' });

      await expect(
        provider().fetch({ url: 'https://a.test/' }),
      ).resolves.toMatchObject({ url: 'https://a.test/' });
    });
  });

  it('rejects a body that is not a string', async () => {
    // A payload whose `content` is not text has nothing to hand the model.
    stubJsonFetch({ content: 42 });

    await expect(provider().fetch({ url: 'https://a.test/' })).rejects.toThrow(
      'found no readable content',
    );
  });

  it('rejects an empty body from the endpoint', async () => {
    stubJsonFetch({ content: '   \n  ' });

    await expect(provider().fetch({ url: 'https://a.test/' })).rejects.toThrow(
      'found no readable content',
    );
  });

  describe('local fallback', () => {
    it('uses the local result when the endpoint fails', async () => {
      stubJsonFetch({ msg: 'unauthorized' }, 401);
      installTransport(({ respond }) => {
        respond({
          body: 'local page text',
          headers: { 'content-type': 'text/plain' },
        });
      });

      const result = await provider({ resolveHost: publicResolver }).fetch({
        prompt: 'the release date',
        url: 'http://a.test/page',
      });

      expect(result.content).toContain('local page text');
      // The local fetch gets the url as given, not the https upgrade.
      expect(result.url).toBe('http://a.test/page');
    });

    it('reports an endpoint failure that is not an Error', async () => {
      stubFetch(async () => {
        throw 'endpoint fell over';
      });
      // The endpoint is not awaited alone: on failure the local attempt is
      // awaited too, so without a stubbed transport this resolves a real
      // hostname and hangs until the test times out.
      installTransport(({ request }) => {
        request.emitError('endpoint fell over');
      });

      await expect(
        provider({ resolveHost: publicResolver }).fetch({
          url: 'https://a.test/',
        }),
      ).rejects.toThrow('endpoint fell over');
    });

    it('abandons a request that outlasts the timeout', async () => {
      stubFetch(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(
                Object.assign(new Error('aborted'), { name: 'AbortError' }),
              ),
            );
          }),
      );
      installTransport(({ request }) => {
        request.emitError('connection reset');
      });

      await expect(
        provider({ timeoutMs: 1_000 }).fetch({ url: 'https://a.test/' }),
      ).rejects.toThrow('aborted');
    });

    it('reports a local failure that is not an Error', async () => {
      stubJsonFetch({ msg: 'unauthorized' }, 401);
      installTransport(({ request }) => {
        request.emitError('local fell over');
      });

      await expect(
        provider({ resolveHost: publicResolver }).fetch({
          url: 'https://a.test/',
        }),
      ).rejects.toThrow('local fallback also failed: local fell over');
    });

    it('reports both reasons when the local fallback also fails', async () => {
      stubJsonFetch({ msg: 'unauthorized' }, 401);
      installTransport(({ request }) => {
        request.emitError(new Error('connection reset'));
      });

      await expect(
        provider({ resolveHost: publicResolver }).fetch({
          url: 'https://a.test/',
        }),
      ).rejects.toThrow('local fallback also failed: connection reset');
    });

    it('reports one reason when both attempts agree', async () => {
      const reason = 'CodeBuddy web fetch error: boom (code: unknown)';
      stubJsonFetch({ msg: 'boom' }, 500);
      installTransport(({ request }) => {
        request.emitError(new Error(reason));
      });

      await expect(
        provider({ resolveHost: publicResolver }).fetch({
          url: 'https://a.test/',
        }),
      ).rejects.toThrow(reason);
    });

    it('reports a failed local fetch that returned a status', async () => {
      stubJsonFetch({ msg: 'unauthorized' }, 401);
      const calls = installTransport(({ respond }) => {
        respond({ statusCode: 500 });
      });

      await expect(
        provider({ resolveHost: publicResolver }).fetch({
          url: 'https://a.test/',
        }),
      ).rejects.toThrow(/local fallback also failed/);
      expect(calls).toHaveLength(1);
    });

    it('prefers the endpoint result when both succeed', async () => {
      stubJsonFetch({ content: 'endpoint text' });
      const calls = installTransport(({ respond }) => {
        respond({
          body: 'local text',
          headers: { 'content-type': 'text/plain' },
        });
      });

      const result = await provider({ resolveHost: publicResolver }).fetch({
        url: 'https://a.test/',
      });

      expect(result.content).toContain('endpoint text');
      expect(result.content).not.toContain('local text');

      // The abandoned local attempt is allowed to finish; wait for it so the
      // request it makes is not recorded against the next test.
      await settle(() => calls.length === 1);
      expect(calls).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Local fetch backend
// ---------------------------------------------------------------------------

describe('local fetch provider', () => {
  const provider = (
    options: { maxContentLength?: number; timeoutMs?: number } = {},
  ) =>
    createLocalFetchProvider({
      maxContentLength: options.maxContentLength,
      resolveHost: publicResolver,
      timeoutMs: options.timeoutMs,
    });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('identifies itself', () => {
    expect(provider().id).toBe('codebuddy2api');
  });

  it('reports a missing url without fetching', async () => {
    const calls = installTransport(({ respond }) => respond());

    const result = await provider().fetch({ url: '   ' });

    expect(calls).toHaveLength(0);
    expect(result.content).toContain('without a URL');
  });

  it('reports a url that is not absolute', async () => {
    const calls = installTransport(({ respond }) => respond());

    const result = await provider().fetch({ url: 'example.test/page' });

    expect(calls).toHaveLength(0);
    expect(result.content).toContain('is not a valid absolute URL');
  });

  it.each(['file:///etc/passwd', 'data:text/plain,hello', 'ftp://a.test/f'])(
    'refuses the %s scheme',
    async (url) => {
      const calls = installTransport(({ respond }) => respond());

      await expect(provider().fetch({ url })).rejects.toThrow(
        'Unsupported URL protocol',
      );
      expect(calls).toHaveLength(0);
    },
  );

  it.each([
    'http://localhost/admin',
    'http://api.localhost/admin',
    'http://127.0.0.1:8080/admin',
    'http://10.1.2.3/admin',
    'http://172.16.0.1/admin',
    'http://192.168.1.1/admin',
    'http://169.254.169.254/latest/meta-data',
    'http://0.0.0.0/admin',
    'http://[::1]/admin',
    'http://[fe80::1]/admin',
    'http://[fd00::1]/admin',
  ])('refuses to fetch the private host %s', async (url) => {
    const calls = installTransport(({ respond }) => respond());

    await expect(provider().fetch({ url })).rejects.toThrow(
      /Refusing to fetch a private or loopback address/,
    );
    expect(calls).toHaveLength(0);
  });

  it('allows a public literal address', async () => {
    const calls = installTransport(({ respond }) =>
      respond({ body: 'ok', headers: { 'content-type': 'text/plain' } }),
    );

    const result = await provider().fetch({ url: 'http://8.8.8.8/dns' });

    expect(calls).toHaveLength(1);
    expect(result.content).toContain('ok');
  });

  it('allows a public IPv6 literal address', async () => {
    const calls = installTransport(({ respond }) =>
      respond({ body: 'ok', headers: { 'content-type': 'text/plain' } }),
    );

    const result = await provider().fetch({
      url: 'http://[2001:4860:4860::8888]/dns',
    });

    expect(calls).toHaveLength(1);
    // The brackets are stripped before the address is pinned.
    expect(calls[0].options.lookup).toBeDefined();
    expect(result.content).toContain('ok');
  });

  it('resolves the host through DNS when no resolver is injected', async () => {
    const lookup = vi
      .spyOn(dns, 'lookup')
      .mockResolvedValue([
        { address: '93.184.216.34', family: 4 },
      ] as unknown as Awaited<ReturnType<typeof dns.lookup>>);
    installTransport(({ respond }) =>
      respond({ body: 'ok', headers: { 'content-type': 'text/plain' } }),
    );

    const result = await createLocalFetchProvider().fetch({
      url: 'http://a.test/page',
    });

    expect(lookup).toHaveBeenCalledWith('a.test', { all: true });
    expect(result.content).toContain('ok');
  });

  it('allows a host whose addresses are all public', async () => {
    const resolver: HostResolver = async () => [
      '93.184.216.34',
      '93.184.216.35',
    ];
    const calls = installTransport(({ respond }) =>
      respond({ body: 'ok', headers: { 'content-type': 'text/plain' } }),
    );

    await expect(
      createLocalFetchProvider({ resolveHost: resolver }).fetch({
        url: 'http://a.test/',
      }),
    ).resolves.toMatchObject({ url: 'http://a.test/' });
    expect(calls).toHaveLength(1);
  });

  it('refuses a host with any private address', async () => {
    const resolver: HostResolver = async () => ['93.184.216.34', '127.0.0.1'];
    installTransport(({ respond }) => respond());

    await expect(
      createLocalFetchProvider({ resolveHost: resolver }).fetch({
        url: 'http://a.test/',
      }),
    ).rejects.toThrow('it resolves to the private address 127.0.0.1');
  });

  it('trusts an operator-supplied override', async () => {
    // Pinning a name to a private address is the point of an override.
    const calls = installTransport(({ respond }) =>
      respond({ body: 'internal', headers: { 'content-type': 'text/plain' } }),
    );

    const result = await createLocalFetchProvider({
      resolveHost: trustedResolver,
    }).fetch({ url: 'http://internal.test/' });

    expect(result.content).toContain('internal');
    expect(calls).toHaveLength(1);
  });

  it('reports a host that cannot be resolved', async () => {
    const failing: HostResolver = async () => {
      throw new Error('ENOTFOUND');
    };
    installTransport(({ respond }) => respond());

    await expect(
      createLocalFetchProvider({ resolveHost: failing }).fetch({
        url: 'http://a.test/',
      }),
    ).rejects.toThrow('could not resolve host: a.test');
  });

  it('reports a host that resolves to nothing', async () => {
    const empty: HostResolver = async () => [];
    installTransport(({ respond }) => respond());

    await expect(
      createLocalFetchProvider({ resolveHost: empty }).fetch({
        url: 'http://a.test/',
      }),
    ).rejects.toThrow('could not resolve host: a.test');
  });

  describe('the pinned request', () => {
    it('pins the socket to the validated address', async () => {
      const calls = installTransport(({ respond }) =>
        respond({ body: 'ok', headers: { 'content-type': 'text/plain' } }),
      );

      await provider().fetch({ url: 'http://a.test/page?q=1' });

      const [call] = calls;
      expect(call.options.host).toBe('a.test');
      expect(call.options.method).toBe('GET');
      expect(call.options.path).toBe('/page?q=1');
      expect(call.options.port).toBe(80);
      // The Host header keeps the real name, so virtual hosting survives.
      expect(call.options.servername).toBeUndefined();
      expect(call.options.headers?.['User-Agent']).toContain('Mozilla/5.0');
      expect(call.options.headers?.Accept).toContain('text/html');
      expect(call.options.headers?.['Accept-Language']).toBe('en-US,en;q=0.9');

      const lookup = call.options.lookup as PinnedLookup;
      const seen: unknown[] = [];
      lookup('a.test', { all: true }, (error, address) =>
        seen.push({ address, error }),
      );
      lookup('a.test', {}, (error, address, family) =>
        seen.push({ address, error, family }),
      );

      expect(seen).toEqual([
        { address: [{ address: '93.184.216.34', family: 4 }], error: null },
        { address: '93.184.216.34', error: null, family: 4 },
      ]);
    });

    it('uses https with its port and servername', async () => {
      const calls = installTransport(({ respond }) =>
        respond({ body: 'ok', headers: { 'content-type': 'text/plain' } }),
      );

      await provider().fetch({ url: 'https://a.test/secure' });

      expect(calls[0].options.port).toBe(443);
      // TLS needs the real hostname for SNI and certificate checks.
      expect(calls[0].options.servername).toBe('a.test');
    });

    it('honours an explicit port', async () => {
      const calls = installTransport(({ respond }) =>
        respond({ body: 'ok', headers: { 'content-type': 'text/plain' } }),
      );

      await provider().fetch({ url: 'https://a.test:8443/secure' });

      expect(calls[0].options.port).toBe(8443);
    });
  });

  it('returns the page text with the source url', async () => {
    installTransport(({ respond }) =>
      respond({ body: 'page body', headers: { 'content-type': 'text/plain' } }),
    );

    const result = await provider().fetch({
      prompt: 'the release date',
      url: 'http://a.test/page',
    });

    expect(result.url).toBe('http://a.test/page');
    expect(result.content).toContain(
      'Web fetch result for http://a.test/page:',
    );
    expect(result.content).toContain('Requested focus: the release date');
    expect(result.content).toContain('page body');
  });

  it('converts HTML to readable text', async () => {
    installTransport(({ respond }) =>
      respond({
        body: '<html><head><title>T</title><style>a{}</style></head><body><h1>Hello</h1><p>One &amp; two</p><script>bad()</script><!-- hidden --></body></html>',
        headers: { 'content-type': 'text/html' },
      }),
    );

    const result = await provider().fetch({ url: 'http://a.test/page' });

    expect(result.content).toContain('Hello');
    expect(result.content).toContain('One & two');
    expect(result.content).not.toContain('bad()');
    expect(result.content).not.toContain('hidden');
    expect(result.content).not.toContain('a{}');
  });

  it('decodes numeric character references', async () => {
    installTransport(({ respond }) =>
      respond({
        // `&#0;` has no character of its own, so it decodes to a space.
        body: '<p>A&#65;B&nbsp;C&#39;D&#0;E</p>',
        headers: { 'content-type': 'text/html' },
      }),
    );

    const result = await provider().fetch({ url: 'http://a.test/page' });

    expect(result.content).toContain("AAB C'D E");
  });

  it('reads a stream that delivers strings rather than buffers', async () => {
    installTransport(({ respond }) => {
      const response = respond({ endStream: false });
      setTimeout(() => {
        response.emit('data', 'plain string body');
        response.emit('end');
      }, 0);
    });

    const result = await provider().fetch({ url: 'http://a.test/page' });

    expect(result.content).toContain('plain string body');
  });

  it('detects HTML when the server sends no content type', async () => {
    installTransport(({ respond }) =>
      respond({ body: '<!doctype html><p>Hi</p>' }),
    );

    const result = await provider().fetch({ url: 'http://a.test/page' });

    expect(result.content).toContain('Hi');
    expect(result.content).not.toContain('<p>');
  });

  it('keeps plain text as it is', async () => {
    installTransport(({ respond }) =>
      respond({
        body: '  # Title\n\nNot html  ',
        headers: { 'content-type': 'text/markdown' },
      }),
    );

    const result = await provider().fetch({ url: 'http://a.test/page' });

    expect(result.content).toContain('# Title');
  });

  it.each(['text/html', 'application/json', 'application/xml', 'text/plain'])(
    'reads the %s content type',
    async (contentType) => {
      installTransport(({ respond }) =>
        respond({
          body: 'body text',
          headers: { 'content-type': contentType },
        }),
      );

      await expect(
        provider().fetch({ url: 'http://a.test/page' }),
      ).resolves.toMatchObject({ url: 'http://a.test/page' });
    },
  );

  it.each(['image/png', 'application/pdf', 'application/octet-stream'])(
    'refuses the %s content type',
    async (contentType) => {
      installTransport(({ respond }) =>
        respond({ body: 'binary', headers: { 'content-type': contentType } }),
      );

      await expect(
        provider().fetch({ url: 'http://a.test/page' }),
      ).rejects.toThrow(`unsupported content type ${contentType}`);
    },
  );

  it('treats a missing content type as text', async () => {
    // `isTextContentType` allows an empty type through, so the refusal's
    // `|| 'unknown'` fallback is unreachable and is not asserted here.
    installTransport(({ respond }) => respond({ body: 'page text' }));

    await expect(
      provider().fetch({ url: 'http://a.test/page' }),
    ).resolves.toMatchObject({ url: 'http://a.test/page' });
  });

  it('truncates a long page to the content limit', async () => {
    installTransport(({ respond }) =>
      respond({
        body: 'a'.repeat(2_000),
        headers: { 'content-type': 'text/plain' },
      }),
    );

    const result = await provider({ maxContentLength: 32 }).fetch({
      url: 'http://a.test/page',
    });

    expect(result.content).toContain('a'.repeat(32));
    expect(result.content).not.toContain('a'.repeat(33));
  });

  it('reports a page with no readable content', async () => {
    installTransport(({ respond }) =>
      respond({ body: '   \n\t ', headers: { 'content-type': 'text/plain' } }),
    );

    await expect(
      provider().fetch({ url: 'http://a.test/page' }),
    ).rejects.toThrow('found no readable content at http://a.test/page');
  });

  it.each([301, 302, 303, 307, 308])(
    'follows a %s redirect and re-validates the target',
    async (status) => {
      const calls = installTransport(({ call, respond }) => {
        if (call === 0) {
          respond({
            headers: { location: '/next' },
            statusCode: status,
          });

          return;
        }

        respond({
          body: 'target text',
          headers: { 'content-type': 'text/plain' },
        });
      });

      const result = await provider().fetch({ url: 'http://a.test/page' });

      expect(calls.map((call) => call.options.path)).toEqual([
        '/page',
        '/next',
      ]);
      expect(result.url).toBe('http://a.test/next');
      expect(result.content).toContain('target text');
    },
  );

  it('refuses a redirect that points at a private address', async () => {
    const calls = installTransport(({ respond }) =>
      respond({
        headers: { location: 'http://localhost/admin' },
        statusCode: 302,
      }),
    );

    await expect(
      provider().fetch({ url: 'http://a.test/page' }),
    ).rejects.toThrow('Refusing to fetch a private or loopback address');
    expect(calls).toHaveLength(1);
  });

  it('reports a redirect with no target', async () => {
    installTransport(({ respond }) => respond({ statusCode: 302 }));

    await expect(
      provider().fetch({ url: 'http://a.test/page' }),
    ).rejects.toThrow('redirect with no target');
  });

  it('uses the first of several location headers', async () => {
    const calls = installTransport(({ call, respond }) => {
      if (call === 0) {
        respond({
          headers: { location: ['/first', '/second'] },
          statusCode: 301,
        });

        return;
      }

      respond({ body: 'ok', headers: { 'content-type': 'text/plain' } });
    });

    const result = await provider().fetch({ url: 'http://a.test/page' });

    expect(calls[1].options.path).toBe('/first');
    expect(result.url).toBe('http://a.test/first');
  });

  it('gives up after too many redirects', async () => {
    const calls = installTransport(({ respond }) =>
      respond({ headers: { location: '/next' }, statusCode: 302 }),
    );

    await expect(
      provider().fetch({ url: 'http://a.test/page' }),
    ).rejects.toThrow('followed more than 5 redirects');
    // Six hops are attempted: the first request plus one per redirect slot.
    expect(calls).toHaveLength(6);
  });

  it('reports an HTTP failure', async () => {
    installTransport(({ respond }) => respond({ statusCode: 404 }));

    await expect(
      provider().fetch({ url: 'http://a.test/page' }),
    ).rejects.toThrow('Web fetch failed with HTTP 404 for http://a.test/page');
  });

  it('reports a response with no status code as a failure', async () => {
    installTransport(({ respond }) => respond({ statusCode: undefined }));

    await expect(
      provider().fetch({ url: 'http://a.test/page' }),
    ).rejects.toThrow('Web fetch failed with HTTP 0');
  });

  it('reports a socket error', async () => {
    installTransport(({ request }) => {
      request.emitError(new Error('socket hang up'));
    });

    await expect(
      provider().fetch({ url: 'http://a.test/page' }),
    ).rejects.toThrow('socket hang up');
  });

  it('gives up when the response never arrives', async () => {
    installTransport(() => undefined);

    await expect(
      provider({ timeoutMs: 1_000 }).fetch({ url: 'http://a.test/page' }),
    ).rejects.toThrow('Web fetch timed out after 1000ms');
  });

  it('stops reading a body that stalls mid-stream', async () => {
    let response: FakeResponse | undefined;
    installTransport(({ respond }) => {
      response = respond({ body: 'start', endStream: false });
    });

    // The response arrived but never ends, so only the socket timeout can
    // release the reader.
    const attempt = provider({ timeoutMs: 1_000 }).fetch({
      url: 'http://a.test/page',
    });
    await tick();
    expect(response?.idleTimeoutListener).not.toBeNull();
    response?.idleTimeoutListener?.();

    await expect(attempt).rejects.toThrow('Web fetch timed out after 1000ms');
  });

  it('ignores a socket error that arrives after the response', async () => {
    installTransport(({ request, respond }) => {
      respond({ body: 'ok', headers: { 'content-type': 'text/plain' } });
      request.emitError(new Error('late error'));
    });

    // The request already answered, so a late error on the socket is not the
    // caller's problem.
    await expect(
      provider().fetch({ url: 'http://a.test/page' }),
    ).resolves.toMatchObject({ url: 'http://a.test/page' });
  });

  it('ignores a second response on the same request', async () => {
    installTransport(({ respond }) => {
      respond({ body: 'first', headers: { 'content-type': 'text/plain' } });
      respond({ body: 'second', headers: { 'content-type': 'text/plain' } });
    });

    const result = await provider().fetch({ url: 'http://a.test/page' });

    expect(result.content).toContain('first');
    expect(result.content).not.toContain('second');
  });

  it('truncates an over-long url before parsing it', async () => {
    const calls = installTransport(({ respond }) =>
      respond({ body: 'ok', headers: { 'content-type': 'text/plain' } }),
    );

    await provider().fetch({ url: `http://a.test/${'p'.repeat(3_000)}` });

    // The cap applies to the whole url, so the path keeps what is left.
    expect(calls[0].options.path).toHaveLength(
      2_048 - 'http://a.test/'.length + 1,
    );
  });
});
