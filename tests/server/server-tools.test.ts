import {
  buildServerToolInvocation,
  classifyServerToolDeclaration,
  executeServerToolInvocations,
  findServerToolDeclarations,
  foldIntermediateTexts,
  getForcedToolName,
  attachServerToolExecutions,
  getServerToolExecutions,
  prepareServerToolTurn,
  hasAmbiguousServerToolName,
  hasExecutableServerTool,
  parseBufferedPayload,
  readBufferedChatCompletionPayload,
  resolveServerToolBackends,
  rewriteServerTools,
  runServerToolTurn,
  type ServerToolInvocation,
} from '@/lib/server/proxy/server-tools';
import { isEventStream } from '@/lib/server/shared/sse';
import { updateSettings } from '@/lib/server/domain/config';
import { resetWebSearchProviders } from '@/lib/server/search';
import type { ChatRequestBody } from '@/lib/server/proxy/codebuddy';
import type {
  WebFetchProvider,
  WebSearchProvider,
} from '@/lib/server/search/types';

/**
 * The classifier is the whole fix, so it is tested on the distinction that was
 * broken rather than on the happy path alone.
 *
 * `normalizeToolName` strips case and separators, so `WebSearch` — the ordinary
 * function Claude Code declares and resolves itself — and `web_search` — the
 * provider-executed server tool — become the same string. Matching on the name
 * made the proxy answer Claude Code's own calls, so the `tool_use` block it was
 * waiting for never arrived. Only the declared type can tell them apart.
 */

const SEARCH_TYPE = 'web_search_20250305';
const FETCH_TYPE = 'web_fetch_20250910';

const claudeCodeWebSearch = {
  name: 'WebSearch',
  description: 'Search the web',
  input_schema: { type: 'object' },
};

const makeSearchProvider = (
  content = 'Search findings',
): WebSearchProvider => ({
  id: 'test-search',
  search: async () => ({
    content,
    results: [
      { content: 'A snippet', title: 'Docs', url: 'https://docs.test' },
    ],
  }),
});

const makeFetchProvider = (): WebFetchProvider => ({
  id: 'test-fetch',
  fetch: async ({ url }) => ({ content: `Fetched ${url}`, url }),
});

const makeJsonResponse = (
  payload: Record<string, unknown>,
  status = 200,
): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const assistantToolCall = (
  name: string,
  args: string,
  id = 'call_1',
): Record<string, unknown> => ({
  choices: [
    {
      finish_reason: 'tool_calls',
      message: {
        content: null,
        role: 'assistant',
        tool_calls: [
          { id, type: 'function', function: { arguments: args, name } },
        ],
      },
    },
  ],
  usage: { total_tokens: 10 },
});

describe('server tool classification', () => {
  describe('declarations', () => {
    it('recognises an Anthropic dated server tool type', () => {
      expect(
        classifyServerToolDeclaration({
          type: SEARCH_TYPE,
          name: 'web_search',
          max_uses: 8,
        }),
      ).toBe('web_search');
    });

    it('recognises a Responses preview server tool type', () => {
      expect(
        classifyServerToolDeclaration({ type: 'web_search_preview' }),
      ).toBe('web_search');
    });

    it('recognises a fetch server tool type', () => {
      expect(
        classifyServerToolDeclaration({ type: FETCH_TYPE, name: 'web_fetch' }),
      ).toBe('web_fetch');
    });

    it('leaves an OpenAI function alone, even one named web_search', () => {
      expect(
        classifyServerToolDeclaration({
          type: 'function',
          function: { name: 'web_search' },
        }),
      ).toBeNull();
    });

    /**
     * The regression. `WebSearch` normalises to the same string as the server
     * tool, so a name-based test cannot tell them apart — and getting it wrong
     * is what made Claude Code's own search silently stop working.
     */
    it('leaves Claude Code’s own WebSearch function alone', () => {
      // Anthropic's shorthand for a client function: no `type` at all.
      expect(classifyServerToolDeclaration(claudeCodeWebSearch)).toBeNull();
      // OpenAI's spelling of the same thing.
      expect(
        classifyServerToolDeclaration({
          type: 'function',
          function: { name: 'WebSearch' },
        }),
      ).toBeNull();
    });

    it('classifies by type even when the name is the client’s spelling', () => {
      expect(
        classifyServerToolDeclaration({
          type: SEARCH_TYPE,
          name: 'WebSearch',
        }),
      ).toBe('web_search');
    });

    it('ignores a declaration that is not an object', () => {
      expect(classifyServerToolDeclaration(null)).toBeNull();
      expect(classifyServerToolDeclaration('web_search')).toBeNull();
    });

    it('leaves an unrelated tool type alone', () => {
      expect(classifyServerToolDeclaration({ type: 'mcp' })).toBeNull();
    });
  });

  describe('findServerToolDeclarations', () => {
    it('returns null when no provider-executed tool is declared', () => {
      expect(findServerToolDeclarations([claudeCodeWebSearch])).toBeNull();
      expect(findServerToolDeclarations(undefined)).toBeNull();
      expect(findServerToolDeclarations([])).toBeNull();
    });

    it('reports which server tools were declared', () => {
      expect(
        findServerToolDeclarations([
          claudeCodeWebSearch,
          { type: SEARCH_TYPE, name: 'web_search' },
        ]),
      ).toEqual({ fetch: false, search: true });
      expect(
        findServerToolDeclarations([
          { type: SEARCH_TYPE, name: 'web_search' },
          { type: FETCH_TYPE, name: 'web_fetch' },
        ]),
      ).toEqual({ fetch: true, search: true });
    });
  });

  describe('name collisions', () => {
    it('flags a client function that collides with an injected server tool', () => {
      expect(
        hasAmbiguousServerToolName([
          { type: SEARCH_TYPE, name: 'web_search' },
          claudeCodeWebSearch,
        ]),
      ).toBe(true);
    });

    it('is not confused by a client function of another name', () => {
      expect(
        hasAmbiguousServerToolName([
          { type: SEARCH_TYPE, name: 'web_search' },
          { name: 'Read', input_schema: {} },
        ]),
      ).toBe(false);
    });

    it('ignores a non-array tool list', () => {
      expect(hasAmbiguousServerToolName(undefined)).toBe(false);
    });

    /**
     * Both would arrive upstream under one name and a model calling it has no
     * way to say which it meant, so the call goes to the client rather than
     * being guessed at.
     */
    it('declines to execute either tool when the names collide', () => {
      const rewrite = rewriteServerTools({
        declarations: { fetch: false, search: true },
        fetchProvider: null,
        searchProvider: makeSearchProvider(),
        tools: [{ type: SEARCH_TYPE, name: 'web_search' }, claudeCodeWebSearch],
      });

      expect(rewrite?.executable).toEqual({ fetch: false, search: false });
      expect(hasExecutableServerTool(rewrite!.executable)).toBe(false);
    });
  });

  describe('rewriteServerTools', () => {
    it('swaps a runnable search declaration for a function upstream can call', () => {
      const rewrite = rewriteServerTools({
        declarations: { fetch: false, search: true },
        fetchProvider: null,
        searchProvider: makeSearchProvider(),
        tools: [{ type: SEARCH_TYPE, name: 'web_search' }],
      });

      expect(rewrite?.executable).toEqual({ fetch: false, search: true });
      expect(rewrite?.tools).toEqual([
        {
          type: 'function',
          function: expect.objectContaining({ name: 'web_search' }),
        },
      ]);
      // Dropped from the follow-up, or the model could search again there.
      expect(rewrite?.followUpTools).toEqual([]);
    });

    it('keeps a declaration with no backend callable for the client', () => {
      const rewrite = rewriteServerTools({
        declarations: { fetch: false, search: true },
        fetchProvider: null,
        searchProvider: null,
        tools: [{ type: SEARCH_TYPE, name: 'web_search' }],
      });

      expect(rewrite?.executable).toEqual({ fetch: false, search: false });
      expect(rewrite?.followUpTools).toHaveLength(1);
    });

    it('leaves a client function untouched in both tool lists', () => {
      const rewrite = rewriteServerTools({
        declarations: { fetch: false, search: true },
        fetchProvider: null,
        searchProvider: makeSearchProvider(),
        tools: [
          { type: SEARCH_TYPE, name: 'web_search' },
          { name: 'Read', input_schema: {} },
        ],
      });

      // The client's own function is forwarded verbatim; only the server
      // declaration is rewritten, and only the rewritten one is dropped from
      // the follow-up.
      expect(rewrite?.tools[1]).toEqual({ name: 'Read', input_schema: {} });
      expect(rewrite?.followUpTools).toEqual([
        { name: 'Read', input_schema: {} },
      ]);
    });

    it('recognises the model’s own spelling of a call it injected', () => {
      const rewrite = rewriteServerTools({
        declarations: { fetch: true, search: true },
        fetchProvider: makeFetchProvider(),
        searchProvider: makeSearchProvider(),
        tools: [
          { type: SEARCH_TYPE, name: 'web_search' },
          { type: FETCH_TYPE, name: 'web_fetch' },
        ],
      });

      // Upstream echoes these back in camel case often enough to matter.
      expect(
        rewrite?.isExecutableCall({ function: { name: 'WebSearch' } }),
      ).toBe(true);
      expect(
        rewrite?.isExecutableCall({ function: { name: 'WebFetch' } }),
      ).toBe(true);
      expect(rewrite?.isExecutableCall({ function: { name: 'Read' } })).toBe(
        false,
      );
    });

    it('does not claim a call when the tool has no backend', () => {
      const rewrite = rewriteServerTools({
        declarations: { fetch: false, search: true },
        fetchProvider: null,
        searchProvider: null,
        tools: [{ type: SEARCH_TYPE, name: 'web_search' }],
      });

      expect(
        rewrite?.isExecutableCall({ function: { name: 'web_search' } }),
      ).toBe(false);
    });
  });

  describe('prepareServerToolTurn', () => {
    it('declines when no provider-executed tool is declared', async () => {
      await expect(
        prepareServerToolTurn([claudeCodeWebSearch]),
      ).resolves.toBeNull();
      await expect(prepareServerToolTurn(undefined)).resolves.toBeNull();
    });
  });

  describe('getForcedToolName', () => {
    it('reads the name from either protocol shape', () => {
      expect(getForcedToolName({ type: 'tool', name: 'web_search' })).toBe(
        'web_search',
      );
      expect(
        getForcedToolName({
          type: 'function',
          function: { name: 'web_search' },
        }),
      ).toBe('web_search');
    });

    it('returns null when no tool is forced', () => {
      expect(getForcedToolName('auto')).toBeNull();
      expect(getForcedToolName({ type: 'auto' })).toBeNull();
    });
  });
});

const body = {
  messages: [{ role: 'user', content: 'when did it ship?' }],
  model: 'test-model',
  stream: false,
};

const makeRewrite = (searchProvider: WebSearchProvider | null) =>
  rewriteServerTools({
    declarations: { fetch: false, search: true },
    fetchProvider: null,
    searchProvider,
    tools: [{ type: SEARCH_TYPE, name: 'web_search' }],
  })!;

describe('server tool turn', () => {
  it('asks upstream once when the model does not call a server tool', async () => {
    const callUpstream = vi.fn(async () =>
      makeJsonResponse({
        choices: [
          { finish_reason: 'stop', message: { content: 'Yesterday.' } },
        ],
      }),
    );

    const outcome = await runServerToolTurn({
      body,
      callUpstream,
      fetchProvider: null,
      rewrite: makeRewrite(makeSearchProvider()),
      searchProvider: makeSearchProvider(),
      stream: false,
    });

    expect(callUpstream).toHaveBeenCalledTimes(1);
    expect(outcome.executions).toEqual([]);
    // The answer it already wrote is the whole turn.
    expect(outcome.preamble.text).toBe('Yesterday.');
  });

  it('runs the search and asks upstream once more for the answer', async () => {
    let calls = 0;
    const callUpstream = vi.fn(async () => {
      calls += 1;

      return calls === 1
        ? makeJsonResponse(assistantToolCall('web_search', '{"query":"ship"}'))
        : makeJsonResponse({
            choices: [
              { finish_reason: 'stop', message: { content: 'It shipped.' } },
            ],
          });
    });

    const outcome = await runServerToolTurn({
      body,
      callUpstream,
      fetchProvider: null,
      rewrite: makeRewrite(makeSearchProvider()),
      searchProvider: makeSearchProvider(),
      stream: false,
    });

    expect(callUpstream).toHaveBeenCalledTimes(2);
    expect(outcome.executions).toHaveLength(1);
    expect(outcome.executions[0]).toMatchObject({
      input: { query: 'ship' },
      type: 'web_search',
    });
    expect((await outcome.response.json()).choices[0].message.content).toBe(
      'It shipped.',
    );
  });

  it('appends the tool result to the follow-up request', async () => {
    let calls = 0;
    const sentBodies: Record<string, unknown>[] = [];
    const callUpstream = vi.fn(async (nextBody) => {
      calls += 1;
      sentBodies.push(nextBody);

      return calls === 1
        ? makeJsonResponse(assistantToolCall('web_search', '{"query":"ship"}'))
        : makeJsonResponse({ choices: [] });
    });

    await runServerToolTurn({
      body,
      callUpstream,
      fetchProvider: null,
      rewrite: makeRewrite(makeSearchProvider()),
      searchProvider: makeSearchProvider(),
      stream: false,
    });

    const followUp = sentBodies[1] as { messages: unknown[] };
    expect(followUp.messages).toHaveLength(3);
    expect(followUp.messages[1]).toMatchObject({ role: 'assistant' });
    expect(followUp.messages[2]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_1',
    });
  });

  it('drops the executed tool so the follow-up cannot search again', async () => {
    let calls = 0;
    const sentBodies: Record<string, unknown>[] = [];
    const callUpstream = vi.fn(async (nextBody) => {
      calls += 1;
      sentBodies.push(nextBody);

      return calls === 1
        ? makeJsonResponse(assistantToolCall('web_search', '{"query":"ship"}'))
        : makeJsonResponse({ choices: [] });
    });

    await runServerToolTurn({
      body,
      callUpstream,
      fetchProvider: null,
      rewrite: makeRewrite(makeSearchProvider()),
      searchProvider: makeSearchProvider(),
      stream: false,
    });

    expect((sentBodies[1] as { tools: unknown[] }).tools).toEqual([]);
  });

  it('relaxes a tool_choice that would force another search', async () => {
    let calls = 0;
    const sentBodies: Record<string, unknown>[] = [];
    const callUpstream = vi.fn(async (nextBody) => {
      calls += 1;
      sentBodies.push(nextBody);

      return calls === 1
        ? makeJsonResponse(assistantToolCall('web_search', '{"query":"ship"}'))
        : makeJsonResponse({ choices: [] });
    });

    await runServerToolTurn({
      body: { ...body, tool_choice: 'required' },
      callUpstream,
      fetchProvider: null,
      rewrite: makeRewrite(makeSearchProvider()),
      searchProvider: makeSearchProvider(),
      stream: false,
    });

    expect(sentBodies[1].tool_choice).toBe('auto');
  });

  it('turns a forced server tool into no tool at all on the follow-up', async () => {
    let calls = 0;
    const sentBodies: Record<string, unknown>[] = [];
    const callUpstream = vi.fn(async (nextBody) => {
      calls += 1;
      sentBodies.push(nextBody);

      return calls === 1
        ? makeJsonResponse(assistantToolCall('web_search', '{"query":"ship"}'))
        : makeJsonResponse({ choices: [] });
    });

    await runServerToolTurn({
      body: {
        ...body,
        tool_choice: { type: 'function', function: { name: 'web_search' } },
      },
      callUpstream,
      fetchProvider: null,
      rewrite: makeRewrite(makeSearchProvider()),
      searchProvider: makeSearchProvider(),
      stream: false,
    });

    expect(sentBodies[1].tool_choice).toBe('none');
  });

  it('hands a failed upstream call back untouched', async () => {
    const callUpstream = vi.fn(async () =>
      makeJsonResponse({ error: { message: 'rate limited' } }, 429),
    );

    const outcome = await runServerToolTurn({
      body,
      callUpstream,
      fetchProvider: null,
      rewrite: makeRewrite(makeSearchProvider()),
      searchProvider: makeSearchProvider(),
      stream: false,
    });

    expect(callUpstream).toHaveBeenCalledTimes(1);
    expect(outcome.executions).toEqual([]);
    expect(outcome.response.status).toBe(429);
  });

  it('reports the invocations it is about to run', async () => {
    let calls = 0;
    const invocations: ServerToolInvocation[] = [];
    const callUpstream = vi.fn(async () => {
      calls += 1;

      return calls === 1
        ? makeJsonResponse(assistantToolCall('web_search', '{"query":"ship"}'))
        : makeJsonResponse({ choices: [] });
    });

    await runServerToolTurn({
      body,
      callUpstream,
      fetchProvider: null,
      onCall: (invocation) => invocations.push(invocation),
      rewrite: makeRewrite(makeSearchProvider()),
      searchProvider: makeSearchProvider(),
      stream: false,
    });

    expect(invocations).toEqual([
      { id: 'call_1', input: { query: 'ship' }, type: 'web_search' },
    ]);
  });

  it('keeps a client-owned call for the client to resolve', async () => {
    let calls = 0;
    const callUpstream = vi.fn(async () => {
      calls += 1;

      return calls === 1
        ? makeJsonResponse(assistantToolCall('Read', '{"path":"/tmp/a"}'))
        : makeJsonResponse({ choices: [] });
    });

    const outcome = await runServerToolTurn({
      body,
      callUpstream,
      fetchProvider: null,
      rewrite: makeRewrite(makeSearchProvider()),
      searchProvider: makeSearchProvider(),
      stream: false,
    });

    // Not ours, so nothing runs and the call goes back exactly as it arrived.
    expect(callUpstream).toHaveBeenCalledTimes(1);
    expect(outcome.executions).toEqual([]);
  });
});

describe('foldIntermediateTexts', () => {
  it('puts prose from earlier hops ahead of the closing message', () => {
    const folded = foldIntermediateTexts(
      { choices: [{ message: { content: 'final' } }] },
      ['first', 'second'],
    );

    expect(folded.choices?.[0]?.message?.content).toBe(
      'first\n\nsecond\n\nfinal',
    );
  });

  it('leaves the payload alone when there is nothing to fold', () => {
    const payload = { choices: [{ message: { content: 'final' } }] };

    expect(foldIntermediateTexts(payload, [])).toBe(payload);
    expect(foldIntermediateTexts({}, ['text'])).toEqual({});
  });
});

describe('server tool plumbing', () => {
  describe('buildServerToolInvocation', () => {
    it('reads a fetch call and keeps the tool call id', () => {
      expect(
        buildServerToolInvocation(
          {
            id: 'call_fetch',
            function: {
              arguments: '{"url":"https://a.test","prompt":"the price"}',
              name: 'web_fetch',
            },
          },
          0,
        ),
      ).toEqual({
        id: 'call_fetch',
        input: { prompt: 'the price', url: 'https://a.test' },
        type: 'web_fetch',
      });
    });

    it('falls back to a positional id when the model sends none', () => {
      expect(
        buildServerToolInvocation({ function: { name: 'web_search' } }, 3),
      ).toEqual({
        id: 'server_tool_3',
        input: { query: '' },
        type: 'web_search',
      });
    });
  });

  describe('executeServerToolInvocations', () => {
    it('runs a fetch through the fetch provider', async () => {
      const results = await executeServerToolInvocations({
        fetchProvider: makeFetchProvider(),
        invocations: [
          {
            id: 'call_fetch',
            input: { url: 'https://a.test' },
            type: 'web_fetch',
          },
        ],
        searchProvider: null,
      });

      expect(results).toEqual([
        {
          content: 'Fetched https://a.test',
          execution: {
            id: 'call_fetch',
            input: { url: 'https://a.test' },
            result: {
              content: 'Fetched https://a.test',
              url: 'https://a.test',
            },
            type: 'web_fetch',
          },
          tool_call_id: 'call_fetch',
        },
      ]);
    });

    it('reports an unconfigured fetch backend as text rather than failing', async () => {
      const results = await executeServerToolInvocations({
        fetchProvider: null,
        invocations: [
          {
            id: 'call_fetch',
            input: { url: 'https://a.test' },
            type: 'web_fetch',
          },
        ],
        searchProvider: null,
      });

      expect(results[0]?.content).toContain('no web fetch backend');
    });
  });

  describe('parseBufferedPayload', () => {
    it('returns the parsed payload', () => {
      expect(parseBufferedPayload('{"choices":[]}', true)).toEqual({
        choices: [],
      });
    });

    it('rethrows a malformed body the upstream called successful', () => {
      expect(() => parseBufferedPayload('not json', true)).toThrow();
    });

    it('tolerates a malformed body on a failure status', () => {
      expect(parseBufferedPayload('not json', false)).toEqual({});
    });
  });

  describe('readBufferedChatCompletionPayload', () => {
    it('falls back to the raw body when a failure carries no message', () => {
      // A payload with only a code has nothing to extract, and the JSON is
      // still the only record of what happened, so it beats the generic
      // "Upstream request failed" — which says only that something failed.
      const response = new Response('{"error":{"code":6004}}', {
        headers: { 'Content-Type': 'application/json' },
        status: 429,
      });

      return expect(
        readBufferedChatCompletionPayload(response),
      ).resolves.toEqual({
        error: { message: '{"error":{"code":6004}}', status: 429 },
      });
    });

    it('uses the generic message when the failure body is empty', () => {
      const response = new Response('', {
        headers: { 'Content-Type': 'application/json' },
        status: 429,
      });

      return expect(
        readBufferedChatCompletionPayload(response),
      ).resolves.toEqual({
        error: {
          message: 'Upstream request failed with status 429',
          status: 429,
        },
      });
    });

    it('prefers the nested upstream message over the generic one', () => {
      const response = new Response('{"error":{"message":"quota exceeded"}}', {
        headers: { 'Content-Type': 'application/json' },
        status: 429,
      });

      return expect(
        readBufferedChatCompletionPayload(response),
      ).resolves.toEqual({
        error: { message: 'quota exceeded', status: 429 },
      });
    });

    it('reports an error payload on a successful status', () => {
      const response = new Response('{"error":{"message":"nope"}}', {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      });

      return expect(
        readBufferedChatCompletionPayload(response),
      ).resolves.toEqual({ error: { message: 'nope' } });
    });
  });

  describe('getServerToolExecutions', () => {
    it('reports none for a response that ran no tools', () => {
      expect(getServerToolExecutions(new Response('{}'))).toEqual([]);
    });
  });

  describe('isEventStream', () => {
    it('tells an SSE response from a buffered one', () => {
      expect(
        isEventStream(
          new Response('{}', {
            headers: { 'Content-Type': 'text/event-stream' },
          }),
        ),
      ).toBe(true);
      expect(
        isEventStream(
          new Response('{}', {
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      ).toBe(false);
      // No content-type at all: upstream omitted it on a failure.
      expect(isEventStream(new Response('{}'))).toBe(false);
    });
  });

  describe('resolveServerToolBackends', () => {
    afterEach(() => {
      vi.restoreAllMocks();
      resetWebSearchProviders();
    });

    it('resolves nothing when both backends are passthrough', async () => {
      await updateSettings({
        CODEBUDDY_WEB_FETCH_BACKEND: 'passthrough',
        CODEBUDDY_WEB_SEARCH_BACKEND: 'passthrough',
      });

      await expect(resolveServerToolBackends()).resolves.toEqual({
        fetchProvider: null,
        searchProvider: null,
      });
    });

    it('resolves the configured backends', async () => {
      process.env.SEARXNG_URL = 'https://searx.test';
      resetWebSearchProviders();
      await updateSettings({
        CODEBUDDY_WEB_FETCH_BACKEND: 'codebuddy2api',
        CODEBUDDY_WEB_SEARCH_BACKEND: 'searxng',
      });

      const { fetchProvider, searchProvider } =
        await resolveServerToolBackends();
      delete process.env.SEARXNG_URL;

      expect(fetchProvider?.id).toBe('local');
      expect(searchProvider?.id).toBe('searxng');
    });
  });

  describe('relaxToolChoice', () => {
    const runWith = async (toolChoice: unknown) => {
      const sentBodies: ChatRequestBody[] = [];
      let calls = 0;

      await runServerToolTurn({
        body: {
          ...body,
          tool_choice: toolChoice,
        } as never,
        callUpstream: async (nextBody) => {
          calls += 1;
          sentBodies.push(nextBody);

          return calls === 1
            ? makeJsonResponse(
                assistantToolCall('web_search', '{"query":"ship"}'),
              )
            : makeJsonResponse({ choices: [] });
        },
        fetchProvider: null,
        rewrite: makeRewrite(makeSearchProvider()),
        searchProvider: makeSearchProvider(),
        stream: false,
      });

      return sentBodies[1]?.tool_choice;
    };

    it('leaves an unrelated tool_choice alone', async () => {
      await expect(runWith('auto')).resolves.toBe('auto');
    });

    it('leaves a forced client tool alone', async () => {
      await expect(
        runWith({ type: 'function', function: { name: 'Read' } }),
      ).resolves.toEqual({ type: 'function', function: { name: 'Read' } });
    });

    it('carries no tool_choice through when none was set', async () => {
      await expect(runWith(undefined)).resolves.toBeUndefined();
    });
  });

  describe('foldIntermediateTexts', () => {
    it('ignores extra text when the payload has no choices', () => {
      expect(foldIntermediateTexts({ choices: [] }, ['orphan'])).toEqual({
        choices: [],
      });
    });
  });
});

describe('server tool edge cases', () => {
  it('builds a search invocation from a call with no name at all', () => {
    expect(buildServerToolInvocation({}, 2)).toEqual({
      id: 'server_tool_2',
      input: { query: '' },
      type: 'web_search',
    });
  });

  it('reports no executions when a turn ran but upstream sent no message', async () => {
    let calls = 0;
    const outcome = await runServerToolTurn({
      body,
      callUpstream: async () => {
        calls += 1;

        return calls === 1
          ? makeJsonResponse({ choices: [{ finish_reason: 'stop' }] })
          : makeJsonResponse({ choices: [] });
      },
      fetchProvider: null,
      rewrite: makeRewrite(makeSearchProvider()),
      searchProvider: makeSearchProvider(),
      stream: false,
    });

    expect(outcome.executions).toEqual([]);
    expect(outcome.preamble).toEqual({ reasoning: '', text: '' });
  });

  it('runs a turn whose body carries no messages', async () => {
    let calls = 0;
    const sentBodies: ChatRequestBody[] = [];
    const outcome = await runServerToolTurn({
      body: { model: 'test-model', stream: false } as ChatRequestBody,
      callUpstream: async (nextBody) => {
        calls += 1;
        sentBodies.push(nextBody);

        return calls === 1
          ? makeJsonResponse(
              assistantToolCall('web_search', '{"query":"ship"}'),
            )
          : makeJsonResponse({ choices: [] });
      },
      fetchProvider: null,
      rewrite: makeRewrite(makeSearchProvider()),
      searchProvider: makeSearchProvider(),
      stream: false,
    });

    expect(outcome.executions).toHaveLength(1);
    // Only the assistant message and the tool result were appended.
    expect((sentBodies[1] as { messages: unknown[] }).messages).toHaveLength(2);
  });

  it('leaves a tool_choice with no name to the follow-up', async () => {
    let calls = 0;
    const sentBodies: ChatRequestBody[] = [];

    await runServerToolTurn({
      body: { ...body, tool_choice: { type: 'auto' } } as never,
      callUpstream: async (nextBody) => {
        calls += 1;
        sentBodies.push(nextBody);

        return calls === 1
          ? makeJsonResponse(
              assistantToolCall('web_search', '{"query":"ship"}'),
            )
          : makeJsonResponse({ choices: [] });
      },
      fetchProvider: null,
      rewrite: makeRewrite(makeSearchProvider()),
      searchProvider: makeSearchProvider(),
      stream: false,
    });

    expect(sentBodies[1].tool_choice).toEqual({ type: 'auto' });
  });

  it('folds extra text into a choice that carries no message', () => {
    const folded = foldIntermediateTexts({ choices: [{ index: 0 }] }, [
      'earlier',
    ]);

    expect(folded.choices?.[0]?.message?.content).toBe('earlier');
  });

  it('records nothing when a turn attaches no executions', () => {
    const response = new Response('{}');

    expect(attachServerToolExecutions(response, [])).toBe(response);
    expect(getServerToolExecutions(response)).toEqual([]);
  });
});
