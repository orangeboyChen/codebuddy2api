/**
 * Coverage for the HTTP search engines.
 *
 * Six engines share one request/parse shape, so the interesting behaviour is
 * the part each one owns — the endpoint, how it authenticates, and where its
 * hits sit in the payload — plus the shared parts a deployment relies on: one
 * timeout, one result budget, and a failure that reads as text rather than as
 * an exception. Nothing here touches the network; `fetch` is stubbed.
 */

import { createBingProvider } from '@/lib/server/search/providers/bing';
import { createBraveProvider } from '@/lib/server/search/providers/brave';
import {
  createDuckduckgoProvider,
  normalizeDuckduckgoRegion,
} from '@/lib/server/search/providers/duckduckgo';
import { createExaProvider } from '@/lib/server/search/providers/exa';
import {
  asSearchResult,
  createJsonSearchProvider,
} from '@/lib/server/search/providers/json-search';
import { createSerperProvider } from '@/lib/server/search/providers/serper';
import { createTavilyProvider } from '@/lib/server/search/providers/tavily';
import { resolveSearchProvider } from '@/lib/server/search';
import { MAX_SNIPPET_LENGTH } from '@/lib/server/search/shared';

const makeJsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

interface FetchCall {
  init: RequestInit;
  url: string;
}

const stubJsonFetch = (
  payload: unknown,
  status = 200,
): { calls: FetchCall[] } => {
  const calls: FetchCall[] = [];

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestInit = (init ?? {}) as RequestInit;
      calls.push({ init: requestInit, url: String(input) });

      return makeJsonResponse(payload, status);
    }) as unknown as typeof fetch,
  );

  return { calls };
};

const headersOf = (init: RequestInit): Headers => new Headers(init.headers);

const bodyOf = (init: RequestInit): Record<string, unknown> =>
  JSON.parse(String(init.body));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the shared engine plumbing', () => {
  it('sends no request for an empty query', async () => {
    const { calls } = stubJsonFetch({ results: [] });
    const result = await createJsonSearchProvider({
      buildRequest: (query) => ({ url: `https://engine.test/?q=${query}` }),
      extractResults: () => [],
      id: 'stub',
      label: 'Stub',
    }).search('   ');

    expect(calls).toEqual([]);
    expect(result.content).toContain('without a query');
  });

  it('reports an HTTP failure with the engine name', async () => {
    stubJsonFetch({}, 503);

    await expect(
      createJsonSearchProvider({
        buildRequest: () => ({ url: 'https://engine.test/' }),
        extractResults: () => [],
        id: 'stub',
        label: 'Stub Search',
      }).search('hello'),
    ).rejects.toThrow('Stub Search search failed with HTTP 503');
  });

  it('caps results at the deployment budget', async () => {
    const payload = Array.from({ length: 8 }, (_item, index) => ({
      content: `snippet ${index}`,
      title: `title ${index}`,
      url: `https://a.test/${index}`,
    }));
    stubJsonFetch({ results: payload });

    const result = await createJsonSearchProvider({
      buildRequest: () => ({ url: 'https://engine.test/' }),
      extractResults: (body) =>
        ((body.results ?? []) as Record<string, unknown>[]).map((item) => ({
          content: item.content as string,
          title: item.title as string,
          url: item.url as string,
        })),
      id: 'stub',
      label: 'Stub',
      maxResults: 3,
    }).search('hello');

    expect(result.results).toHaveLength(3);
  });

  it('truncates a long snippet so one hit cannot dominate the prompt', async () => {
    stubJsonFetch({
      results: [
        { content: 'x'.repeat(5_000), title: 'T', url: 'https://a.test' },
      ],
    });

    const result = await createJsonSearchProvider({
      buildRequest: () => ({ url: 'https://engine.test/' }),
      extractResults: (body) =>
        ((body.results ?? []) as Record<string, unknown>[]).map((item) =>
          asSearchResult(item),
        ),
      id: 'stub',
      label: 'Stub',
    }).search('hello');

    expect(result.results[0].content?.length).toBeLessThanOrEqual(
      MAX_SNIPPET_LENGTH,
    );
  });
});

describe('DuckDuckGo', () => {
  it('sends the region the console stored', async () => {
    // The registry is what turns a stored setting into a request; a key spelled
    // differently on either side would otherwise never reach the wire.
    const { calls } = stubJsonFetch({ RelatedTopics: [] });

    await resolveSearchProvider('duckduckgo', {
      search: { duckduckgoRegion: 'cn-zh' },
    })?.search('hello');

    expect(calls[0].url).toContain('kl=cn-zh');
  });

  it('asks for JSON answers in the selected region', async () => {
    const { calls } = stubJsonFetch({ RelatedTopics: [] });

    await createDuckduckgoProvider({ region: 'cn-zh' }).search('hello world');

    expect(calls[0].url).toContain('https://api.duckduckgo.com/?');
    expect(calls[0].url).toContain('q=hello+world');
    expect(calls[0].url).toContain('kl=cn-zh');
    expect(calls[0].url).toContain('format=json');
  });

  it('returns the abstract and the related topics', async () => {
    stubJsonFetch({
      AbstractText: 'The abstract.',
      AbstractURL: 'https://en.wikipedia.org/wiki/Go',
      Heading: 'Go',
      RelatedTopics: [
        {
          FirstURL: 'https://go.dev/',
          Text: 'The Go programming language',
        },
      ],
    });

    const result = await createDuckduckgoProvider().search('go');

    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toMatchObject({
      content: 'The abstract.',
      title: 'Go',
      url: 'https://en.wikipedia.org/wiki/Go',
    });
    // An instant answer carries no title, so the host stands in for one.
    expect(result.results[1]).toMatchObject({
      content: 'The Go programming language',
      title: 'go.dev',
      url: 'https://go.dev/',
    });
  });

  it('flattens nested topic groups', async () => {
    stubJsonFetch({
      RelatedTopics: [
        {
          Name: 'Group',
          Topics: [
            { FirstURL: 'https://a.test/', Text: 'A' },
            { FirstURL: 'https://b.test/', Text: 'B' },
          ],
        },
        { FirstURL: 'https://c.test/', Text: 'C' },
      ],
    });

    const result = await createDuckduckgoProvider().search('q');

    expect(result.results.map((item) => item.url)).toEqual([
      'https://a.test/',
      'https://b.test/',
      'https://c.test/',
    ]);
  });

  it('skips topics with no url or no text', async () => {
    stubJsonFetch({
      RelatedTopics: [
        { FirstURL: 'https://a.test/' },
        { Text: 'no url' },
        'not an object',
        { FirstURL: 'https://b.test/', Text: 'B' },
      ],
    });

    const result = await createDuckduckgoProvider().search('q');

    expect(result.results).toHaveLength(1);
  });

  it('falls back to worldwide for a region it cannot send', () => {
    expect(normalizeDuckduckgoRegion('cn-zh')).toBe('cn-zh');
    expect(normalizeDuckduckgoRegion('CN-ZH')).toBe('cn-zh');
    expect(normalizeDuckduckgoRegion('zh-CN')).toBe('zh-cn');
    expect(normalizeDuckduckgoRegion('worldwide')).toBe('wt-wt');
    expect(normalizeDuckduckgoRegion('zh_CN')).toBe('wt-wt');
    expect(normalizeDuckduckgoRegion('')).toBe('wt-wt');
    expect(normalizeDuckduckgoRegion(undefined)).toBe('wt-wt');
  });
});

describe('Brave Search', () => {
  it('sends the subscription token and the result count', async () => {
    const { calls } = stubJsonFetch({ web: { results: [] } });

    await createBraveProvider({ apiKey: 'brave-key', maxResults: 2 }).search(
      'hello',
    );

    expect(calls[0].url).toBe(
      'https://api.search.brave.com/res/v1/web/search?count=2&q=hello',
    );
    expect(headersOf(calls[0].init).get('X-Subscription-Token')).toBe(
      'brave-key',
    );
  });

  it('reads hits out of the web section', async () => {
    stubJsonFetch({
      web: {
        results: [
          { description: 'Snippet', title: 'Title', url: 'https://a.test' },
        ],
      },
    });

    const result = await createBraveProvider({ apiKey: 'k' }).search('q');

    expect(result.results).toEqual([
      { content: 'Snippet', title: 'Title', url: 'https://a.test' },
    ]);
  });

  it('yields no hits when the web section is missing', async () => {
    stubJsonFetch({});

    await expect(
      createBraveProvider({ apiKey: 'k' }).search('q'),
    ).resolves.toMatchObject({ results: [] });
  });
});

describe('Tavily', () => {
  it('posts the key and the result count', async () => {
    const { calls } = stubJsonFetch({ results: [] });

    await createTavilyProvider({ apiKey: 'tavily-key' }).search('hello');

    expect(calls[0].url).toBe('https://api.tavily.com/search');
    expect(calls[0].init.method).toBe('POST');
    expect(bodyOf(calls[0].init)).toMatchObject({
      api_key: 'tavily-key',
      query: 'hello',
      search_depth: 'basic',
    });
  });

  it('reads hits from the results array', async () => {
    stubJsonFetch({
      results: [{ content: 'Text', title: 'Title', url: 'https://a.test' }],
    });

    const result = await createTavilyProvider({ apiKey: 'k' }).search('q');

    expect(result.results[0]).toMatchObject({ content: 'Text' });
  });
});

describe('Serper', () => {
  it('posts the query with the key in a header', async () => {
    const { calls } = stubJsonFetch({ organic: [] });

    await createSerperProvider({ apiKey: 'serper-key' }).search('hello');

    expect(calls[0].url).toBe('https://google.serper.dev/search');
    expect(headersOf(calls[0].init).get('X-API-KEY')).toBe('serper-key');
    expect(bodyOf(calls[0].init)).toMatchObject({ q: 'hello' });
  });

  it('maps Google organic hits, whose url field is `link`', async () => {
    stubJsonFetch({
      organic: [{ link: 'https://a.test', snippet: 'Snip', title: 'Title' }],
    });

    const result = await createSerperProvider({ apiKey: 'k' }).search('q');

    expect(result.results).toEqual([
      { content: 'Snip', title: 'Title', url: 'https://a.test' },
    ]);
  });
});

describe('Bing', () => {
  it('sends the subscription key header', async () => {
    const { calls } = stubJsonFetch({ webPages: { value: [] } });

    await createBingProvider({ apiKey: 'bing-key' }).search('hello');

    expect(calls[0].url).toBe(
      'https://api.bing.microsoft.com/v7.0/search?count=5&q=hello',
    );
    expect(headersOf(calls[0].init).get('Ocp-Apim-Subscription-Key')).toBe(
      'bing-key',
    );
  });

  it('maps webPages hits, whose title field is `name`', async () => {
    stubJsonFetch({
      webPages: {
        value: [{ name: 'Title', snippet: 'Snip', url: 'https://a.test' }],
      },
    });

    const result = await createBingProvider({ apiKey: 'k' }).search('q');

    expect(result.results).toEqual([
      { content: 'Snip', title: 'Title', url: 'https://a.test' },
    ]);
  });

  it('yields no hits when webPages is absent', async () => {
    stubJsonFetch({});

    await expect(
      createBingProvider({ apiKey: 'k' }).search('q'),
    ).resolves.toMatchObject({ results: [] });
  });
});

describe('Exa', () => {
  it('posts the query and asks for bounded page text', async () => {
    const { calls } = stubJsonFetch({ results: [] });

    await createExaProvider({ apiKey: 'exa-key', maxResults: 4 }).search(
      'hello',
    );

    expect(calls[0].url).toBe('https://api.exa.ai/search');
    expect(headersOf(calls[0].init).get('x-api-key')).toBe('exa-key');
    expect(bodyOf(calls[0].init)).toMatchObject({
      numResults: 4,
      query: 'hello',
    });
  });

  it('maps results, whose text field holds the page content', async () => {
    stubJsonFetch({
      results: [{ text: 'Page text', title: 'Title', url: 'https://a.test' }],
    });

    const result = await createExaProvider({ apiKey: 'k' }).search('q');

    expect(result.results[0]).toMatchObject({ content: 'Page text' });
  });
});
