import {
  buildServerToolInvocation,
  classifyServerToolDeclaration,
  executeServerToolInvocations,
  findServerToolDeclarations,
  foldIntermediateTexts,
  getForcedToolName,
  attachServerToolExecutions,
  getServerToolExecutions,
  hasAmbiguousServerToolName,
  hasExecutableServerTool,
  readMaxUses,
  parseBufferedPayload,
  readBufferedChatCompletionPayload,
  resolveServerToolBackends,
  rewriteServerTools,
  runServerToolTurn,
  type ServerToolInvocation,
  type ServerToolTurnOutcome,
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

/** An upstream that died behind a gateway: an HTML page on a success status. */
const makeHtmlResponse = (): Response =>
  new Response('<html><body>502 Bad Gateway</body></html>', {
    headers: { 'Content-Type': 'text/html' },
    status: 200,
  });

/**
 * The tool calls a response still asks the client to answer, and the
 * `finish_reason` that introduces them.
 *
 * Both halves of the same question: a `tool_use` left in the payload is a call
 * the client has to resolve, and a `tool_calls` finish reason is what makes it
 * wait for one.
 */
const outstandingCalls = async (
  response: Response,
): Promise<{
  finishReason: string | null | undefined;
  names: Array<string | undefined>;
}> => {
  const payload = (await response.json()) as {
    choices?: Array<{
      finish_reason?: string | null;
      message?: { tool_calls?: Array<{ function?: { name?: string } }> };
    }>;
  };
  const choice = payload.choices?.[0];

  return {
    finishReason: choice?.finish_reason,
    names: (choice?.message?.tool_calls ?? []).map(
      (call) => call.function?.name,
    ),
  };
};

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
    it('does not treat the client’s WebSearch as a collision', () => {
      // This pairing is Claude Code's normal shape in a single request, so
      // calling it ambiguous disabled the server tool outright — the client
      // then received a `web_search` tool_use it had no handler for.
      expect(
        hasAmbiguousServerToolName(
          [{ type: SEARCH_TYPE, name: 'web_search' }, claudeCodeWebSearch],
          'web_search',
        ),
      ).toBe(false);
    });

    it('flags a genuine name clash: the same name, two kinds', () => {
      // Here the model really could not say which it meant, so neither runs.
      expect(
        hasAmbiguousServerToolName(
          [
            { type: SEARCH_TYPE, name: 'web_search' },
            { name: 'web_search', input_schema: {} },
          ],
          'web_search',
        ),
      ).toBe(true);
    });

    it('is not confused by a client function of another name', () => {
      expect(
        hasAmbiguousServerToolName(
          [
            { type: SEARCH_TYPE, name: 'web_search' },
            { name: 'Read', input_schema: {} },
          ],
          'web_search',
        ),
      ).toBe(false);
    });

    it('ignores a non-array tool list', () => {
      expect(hasAmbiguousServerToolName(undefined, 'web_search')).toBe(false);
    });

    /**
     * Both would arrive upstream under one name and a model calling it has no
     * way to say which it meant, so the call goes to the client rather than
     * being guessed at.
     */
    it('runs the server tool when the client’s own WebSearch is present', () => {
      const rewrite = rewriteServerTools({
        declarations: { fetch: false, search: true },
        fetchProvider: null,
        searchProvider: makeSearchProvider(),
        tools: [{ type: SEARCH_TYPE, name: 'web_search' }, claudeCodeWebSearch],
      });

      // The declared type already tells them apart, so the search runs and the
      // client keeps its own tool.
      expect(rewrite?.executable).toEqual({ fetch: false, search: true });
      expect(hasExecutableServerTool(rewrite!.executable)).toBe(true);
      expect(rewrite?.classifyCall({ function: { name: 'web_search' } })).toBe(
        'web_search',
      );
      // The client's own tool, left for it: it declared `WebSearch` itself, so
      // the respelled-name fallback is deliberately not registered.
      expect(rewrite?.classifyCall({ function: { name: 'WebSearch' } })).toBe(
        null,
      );
    });

    it('declines both tools when the names are genuinely identical', () => {
      const rewrite = rewriteServerTools({
        declarations: { fetch: false, search: true },
        fetchProvider: null,
        searchProvider: makeSearchProvider(),
        tools: [
          { type: SEARCH_TYPE, name: 'web_search' },
          { name: 'web_search', input_schema: {} },
        ],
      });

      expect(rewrite?.executable).toEqual({ fetch: false, search: false });
      expect(hasExecutableServerTool(rewrite!.executable)).toBe(false);
    });

    /**
     * Ambiguity belongs to one name, so it is answered for one kind at a time.
     * A single request-wide verdict withheld the search over a clash on the
     * fetch's name, and the client got no server tool at all for a collision
     * it had nothing to do with.
     */
    it('withholds only the server tool whose name collides', () => {
      const rewrite = rewriteServerTools({
        declarations: { fetch: true, search: true },
        fetchProvider: makeFetchProvider(),
        searchProvider: makeSearchProvider(),
        tools: [
          { type: SEARCH_TYPE, name: 'web_search' },
          { type: FETCH_TYPE, name: 'web_fetch' },
          // The client's own function, spelled exactly like the fetch tool:
          // upstream cannot tell the two apart, so that one is left to it.
          { name: 'web_fetch', input_schema: {} },
        ],
      });

      expect(rewrite?.executable).toEqual({ fetch: false, search: true });
      expect(hasExecutableServerTool(rewrite!.executable)).toBe(true);
      // The search is still ours to run, and the fetch call goes back to the
      // client — the one that declared a function of that name.
      expect(
        rewrite?.isExecutableCall({ function: { name: 'web_search' } }),
      ).toBe(true);
      expect(
        rewrite?.isExecutableCall({ function: { name: 'web_fetch' } }),
      ).toBe(false);
    });

    it('leaves the fetch runnable when the search name is what collides', () => {
      const rewrite = rewriteServerTools({
        declarations: { fetch: true, search: true },
        fetchProvider: makeFetchProvider(),
        searchProvider: makeSearchProvider(),
        tools: [
          { type: SEARCH_TYPE, name: 'web_search' },
          { type: FETCH_TYPE, name: 'web_fetch' },
          { name: 'web_search', input_schema: {} },
        ],
      });

      expect(rewrite?.executable).toEqual({ fetch: true, search: false });
      expect(hasExecutableServerTool(rewrite!.executable)).toBe(true);
      expect(
        rewrite?.isExecutableCall({ function: { name: 'web_fetch' } }),
      ).toBe(true);
      expect(
        rewrite?.isExecutableCall({ function: { name: 'web_search' } }),
      ).toBe(false);
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
    });

    it('withdraws a declaration no backend can run, rather than offering it', () => {
      const rewrite = rewriteServerTools({
        declarations: { fetch: false, search: true },
        fetchProvider: null,
        searchProvider: null,
        tools: [{ type: SEARCH_TYPE, name: 'web_search' }],
      });

      expect(rewrite?.executable).toEqual({ fetch: false, search: false });
      // Offering the tool anyway would have the model call it and hand the
      // client a `tool_use` for a name it declared as provider-executed and
      // has no handler for: no search, and a turn it cannot complete.
      expect(rewrite?.tools).toEqual([]);
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
      // declaration is rewritten.
      expect(rewrite?.tools[0]).toEqual({
        type: 'function',
        function: expect.objectContaining({ name: 'web_search' }),
      });
      expect(rewrite?.tools[1]).toEqual({ name: 'Read', input_schema: {} });
    });

    /**
     * The regression, from the other side. `WebSearch` is the tool *Claude
     * Code* declares and resolves itself; normalised it is indistinguishable
     * from the server tool, so a loose match here is what let the proxy answer
     * calls the client meant to handle.
     *
     * The names the proxy injected are its own, so an exact match is all that
     * is needed — and a miss means the call is the client's, which is the safe
     * direction to be wrong in.
     */
    it('recognises its own calls, including when upstream respells them', () => {
      const rewrite = rewriteServerTools({
        declarations: { fetch: true, search: true },
        fetchProvider: makeFetchProvider(),
        searchProvider: makeSearchProvider(),
        tools: [
          { type: SEARCH_TYPE, name: 'web_search' },
          { type: FETCH_TYPE, name: 'web_fetch' },
        ],
      });

      // Ours, exactly as handed to upstream.
      expect(
        rewrite?.isExecutableCall({ function: { name: 'web_search' } }),
      ).toBe(true);
      expect(
        rewrite?.isExecutableCall({ function: { name: 'web_fetch' } }),
      ).toBe(true);

      // Respelled by upstream. Safe to accept precisely because this request
      // declares no client function of that name, so a call spelled `WebSearch`
      // can only be our own tool coming back in another hand.
      expect(
        rewrite?.isExecutableCall({ function: { name: 'WebSearch' } }),
      ).toBe(true);
      expect(
        rewrite?.isExecutableCall({ function: { name: 'Web Fetch' } }),
      ).toBe(true);

      // Still not ours.
      expect(rewrite?.isExecutableCall({ function: { name: 'Read' } })).toBe(
        false,
      );
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
    });

    expect(callUpstream).toHaveBeenCalledTimes(1);
    expect(outcome.executions).toEqual([]);
    // It answered outright, so there is no preamble — the answer stays in the
    // payload where the renderer will find it.
    expect(outcome.segments).toEqual([]);
    expect((await outcome.response.json()).choices[0].message.content).toBe(
      'Yesterday.',
    );
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
    });

    const followUp = sentBodies[1] as { messages: unknown[] };
    expect(followUp.messages).toHaveLength(3);
    expect(followUp.messages[1]).toMatchObject({ role: 'assistant' });
    expect(followUp.messages[2]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_1',
    });
  });

  it('keeps the server tool callable so the model can refine its query', async () => {
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
    });

    // Still there: whether to search again is the model's call, not ours.
    expect((sentBodies[1] as { tools: unknown[] }).tools).toEqual([
      expect.objectContaining({
        function: expect.objectContaining({ name: 'web_search' }),
      }),
    ]);
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
    });

    expect(sentBodies[1].tool_choice).toBe('auto');
  });

  it('loosens a forced server tool to let the model choose', async () => {
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
    });

    // Not `none`: the model may still want a second search, it just must not
    // be compelled into one forever.
    expect(sentBodies[1].tool_choice).toBe('auto');
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
          'web_fetch',
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
        buildServerToolInvocation(
          { function: { name: 'web_search' } },
          'web_search',
          3,
        ),
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

    it('resolves nothing when the selected backends cannot run', async () => {
      // SearXNG with no instance, and Browserable with no address: both are
      // selected but neither can be built, so neither tool is advertised.
      await updateSettings({
        CODEBUDDY_SEARXNG_URL: '',
        CODEBUDDY_WEB_FETCH_BACKEND: 'browserable',
        CODEBUDDY_WEB_SEARCH_BACKEND: 'searxng',
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

      expect(fetchProvider?.id).toBe('codebuddy2api');
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
    expect(buildServerToolInvocation({}, 'web_search', 2)).toEqual({
      id: 'server_tool_2',
      input: { query: '' },
      type: 'web_search',
    });
  });

  it('reports no executions when a turn ran but upstream sent no message', async () => {
    let calls = 0;
    outcomeCalls = 0;
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
    });

    expect(outcome.executions).toEqual([]);
    expect(outcome.segments).toEqual([]);
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

describe('budget and call-matching edges', () => {
  it('falls back to the default budget when there is no tool list', () => {
    expect(readMaxUses(undefined, 'web_search')).toBe(5);
    expect(readMaxUses('not-an-array', 'web_fetch')).toBe(5);
  });

  it('ignores a declared budget that is not a usable number', () => {
    const tools = [{ type: SEARCH_TYPE, name: 'web_search', max_uses: 'many' }];

    expect(readMaxUses(tools, 'web_search')).toBe(5);
  });

  it('claims nothing for a call that has no name', () => {
    const rewrite = makeRewrite(makeSearchProvider());

    expect(rewrite?.classifyCall({})).toBeNull();
    expect(rewrite?.classifyCall({ function: {} })).toBeNull();
  });
});

/**
 * The searches have already run and been billed by the time the closing hop
 * fails, so they must not vanish along with it.
 */
it('keeps the searches and the usage when the closing hop fails', async () => {
  closingCalls = 0;
  const outcome = await runServerToolTurn({
    body,
    callUpstream: async () => {
      const hop =
        closingCalls++ === 0
          ? assistantToolCall('web_search', '{"query":"q"}')
          : { error: { message: 'rate limited' } };

      return makeJsonResponse(hop, closingCalls === 1 ? 200 : 429);
    },
    fetchProvider: null,
    rewrite: rewriteServerTools({
      declarations: { fetch: false, search: true },
      fetchProvider: null,
      searchProvider: makeSearchProvider(),
      tools: [{ type: SEARCH_TYPE, name: 'web_search', max_uses: 1 }],
    }),
    searchProvider: makeSearchProvider(),
  });

  expect(outcome.executions).toHaveLength(1);
  // Accrued before the failure, and the only record the client gets.
  expect(outcome.usage).toEqual({ total_tokens: 10 });
  expect(getServerToolExecutions(outcome.response)).toHaveLength(1);
});

/**
 * A hop that asks for a server tool *and* something the client owns. The
 * search runs, but the turn cannot continue here — the client has to answer
 * its own call first — so the findings go back with that call outstanding.
 */
it('runs the search but hands a client call back unresolved', async () => {
  const outcome = await runServerToolTurn({
    body,
    callUpstream: async () =>
      makeJsonResponse({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: 'Let me check that file first.',
              role: 'assistant',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: {
                    arguments: '{"query":"q"}',
                    name: 'web_search',
                  },
                },
                {
                  id: 'call_2',
                  type: 'function',
                  function: { arguments: '{}', name: 'Read' },
                },
              ],
            },
          },
        ],
      }),
    fetchProvider: null,
    rewrite: makeRewrite(makeSearchProvider()),
    searchProvider: makeSearchProvider(),
  });

  // One search ran, and the client's call survives for it to answer.
  expect(outcome.executions).toHaveLength(1);
  // The prose that led to the search stays with it, as its own segment.
  expect(outcome.segments).toEqual([
    {
      executions: outcome.executions,
      reasoning: '',
      text: 'Let me check that file first.',
    },
  ]);

  const payload = (await outcome.response.json()) as {
    choices: Array<{
      finish_reason: string | null;
      message: {
        content: string | null;
        tool_calls?: Array<{ function?: { name?: string } }>;
      };
    }>;
  };

  expect(
    payload.choices[0]?.message.tool_calls?.map((c) => c.function?.name),
  ).toEqual(['Read']);
  expect(payload.choices[0]?.finish_reason).toBe('tool_calls');
  // The prose travels as the preamble, not duplicated on the payload.
  expect(payload.choices[0]?.message.content).toBeNull();
});

it('copes with a hop that carries no message at all', async () => {
  const outcome = await runServerToolTurn({
    body,
    callUpstream: async () => makeJsonResponse({ choices: [{}] }),
    fetchProvider: null,
    rewrite: makeRewrite(makeSearchProvider()),
    searchProvider: makeSearchProvider(),
  });

  // No call to answer and no prose to keep: the hop is the turn.
  expect(outcome.executions).toEqual([]);
  expect(outcome.segments).toEqual([]);
});

describe('server tool loop', () => {
  /** Answers each hop in turn, so a test can script a multi-hop model. */
  const scripted = (
    hops: Array<Record<string, unknown>>,
    maxUses = 5,
  ): {
    run: () => Promise<ServerToolTurnOutcome>;
    sentBodies: () => ChatRequestBody[];
  } => {
    const sentBodies: ChatRequestBody[] = [];
    let calls = 0;

    const run = (): Promise<ServerToolTurnOutcome> =>
      runServerToolTurn({
        body,
        callUpstream: async (nextBody) => {
          sentBodies.push(nextBody);
          const hop = hops[Math.min(calls, hops.length - 1)];
          calls += 1;

          return makeJsonResponse(hop);
        },
        fetchProvider: null,
        rewrite: rewriteServerTools({
          declarations: { fetch: false, search: true },
          fetchProvider: null,
          searchProvider: makeSearchProvider(),
          tools: [{ type: SEARCH_TYPE, name: 'web_search', max_uses: maxUses }],
        })!,
        searchProvider: makeSearchProvider(),
      });

    return { run, sentBodies: () => sentBodies };
  };

  const ask = (query: string, id = 'call_1') =>
    assistantToolCall('web_search', `{"query":"${query}"}`, id);

  /**
   * Both kinds runnable, which is the only shape in which a hop can afford
   * nothing while the turn still has allowance left: with one kind alone, the
   * hop that asks for it either runs or ends the turn.
   *
   * The last hop repeats forever, so a model that never stops asking is
   * scripted by giving it a single hop.
   */
  const scriptedBoth = (
    hops: Array<Record<string, unknown>>,
    budgets: { fetch: number; search: number } = { fetch: 5, search: 5 },
  ): {
    run: () => Promise<ServerToolTurnOutcome>;
    upstreamCalls: () => number;
  } => {
    let calls = 0;

    const run = (): Promise<ServerToolTurnOutcome> =>
      runServerToolTurn({
        body,
        callUpstream: async () => {
          calls += 1;

          // A ceiling rather than an endless script. A turn that stops
          // terminating has to fail this test, not hang the suite with it.
          if (calls > 25) {
            throw new Error(
              `the turn did not terminate: ${calls} upstream calls`,
            );
          }

          return makeJsonResponse(hops[Math.min(calls - 1, hops.length - 1)]);
        },
        fetchProvider: makeFetchProvider(),
        rewrite: rewriteServerTools({
          declarations: { fetch: true, search: true },
          fetchProvider: makeFetchProvider(),
          searchProvider: makeSearchProvider(),
          tools: [
            { type: SEARCH_TYPE, name: 'web_search', max_uses: budgets.search },
            { type: FETCH_TYPE, name: 'web_fetch', max_uses: budgets.fetch },
          ],
        }),
        searchProvider: makeSearchProvider(),
      });

    return { run, upstreamCalls: () => calls };
  };

  /**
   * The model never stops asking, but only ever asks for the kind whose budget
   * is gone. Such a hop executes nothing and appends nothing, so the transcript
   * never advances and the loop re-issues an identical request — each one a
   * real billed round trip. Affordability is per hop, so that is a reason to
   * stop even though the other kind still has allowance left.
   */
  it('terminates when the model only ever asks for the spent kind', async () => {
    const { run, upstreamCalls } = scriptedBoth(
      [assistantToolCall('web_fetch', '{"url":"https://a.test"}', 'call_1')],
      { fetch: 1, search: 8 },
    );

    const outcome = await run();

    // The first fetch ran; the second ask could afford nothing.
    expect(outcome.executions).toHaveLength(1);
    // One hop that ran, one that could not, and one closing call.
    expect(upstreamCalls()).toBe(3);
  });

  /**
   * The point of a server tool: the model refines its query and searches
   * again, all inside the one request the client sent.
   */
  it('searches again when the model is not satisfied', async () => {
    const { run, sentBodies } = scripted([
      ask('quantum computing', 'call_1'),
      ask('IBM quantum 2026', 'call_2'),
      {
        choices: [
          { finish_reason: 'stop', message: { content: 'Here it is.' } },
        ],
      },
    ]);

    const outcome = await run();

    expect(sentBodies()).toHaveLength(3);
    expect(outcome.executions).toHaveLength(2);
    expect(
      outcome.executions.map((execution) =>
        execution.type === 'web_search' ? execution.input.query : '',
      ),
    ).toEqual(['quantum computing', 'IBM quantum 2026']);
    // Every search plus the answer is one turn from the client's side.
    expect((await outcome.response.json()).choices[0].message.content).toBe(
      'Here it is.',
    );
  });

  it('grows the transcript by one tool result per search', async () => {
    const { run, sentBodies } = scripted([
      ask('one', 'call_1'),
      ask('two', 'call_2'),
      { choices: [{ finish_reason: 'stop', message: { content: 'done' } }] },
    ]);

    await run();

    // user, assistant+tool, assistant+tool
    expect(sentBodies()[1].messages).toHaveLength(3);
    expect(sentBodies()[2].messages).toHaveLength(5);
    expect(
      (sentBodies()[2].messages as Array<{ tool_call_id?: string }>).map(
        (message) => message.tool_call_id,
      ),
      // user, assistant(tool_calls), tool(call_1), assistant(tool_calls), tool(call_2)
    ).toEqual([undefined, undefined, 'call_1', undefined, 'call_2']);
  });

  /**
   * `max_uses` bounds the turn, not the hop. Once it is spent the server tools
   * are withdrawn for one last call so the model answers with what it has
   * instead of asking for a search it will not get.
   */
  it('stops at max_uses and asks once more without the server tool', async () => {
    const { run, sentBodies } = scripted(
      [ask('one', 'call_1'), ask('two', 'call_2'), ask('three', 'call_3')],
      2,
    );

    const outcome = await run();

    expect(outcome.executions).toHaveLength(2);
    // The closing call has no server tool left to call.
    expect((sentBodies()[2] as { tools: unknown[] }).tools).toEqual([]);
    // Nothing is left to choose from, so no tool_choice is sent at all: naming
    // a tool that is not on offer is a contradiction some upstreams reject.
    expect(sentBodies()[2].tool_choice).toBeUndefined();
  });

  it('reports usage for every hop, not just the last', async () => {
    const hops = [
      { ...ask('one', 'call_1'), usage: { total_tokens: 100 } },
      { ...ask('two', 'call_2'), usage: { total_tokens: 240 } },
      {
        choices: [{ finish_reason: 'stop', message: { content: 'done' } }],
        usage: { total_tokens: 80 },
      },
    ];

    const outcome = await scripted(hops).run();

    // Under-reporting the turn by every search that preceded the answer would
    // bill the client for one hop out of three.
    expect(outcome.usage).toEqual({ total_tokens: 420 });
    expect((await outcome.response.json()).usage).toEqual({
      total_tokens: 420,
    });
  });

  it('hands a failed hop back with the usage accrued so far', async () => {
    const { run } = scripted([
      { ...ask('one', 'call_1'), usage: { total_tokens: 100 } },
      { error: { message: 'rate limited' } },
    ]);

    const outcome = await run();

    expect(outcome.response.status).toBe(200);
    expect(outcome.usage).toEqual({ total_tokens: 100 });
  });
});

/**
 * These pin the behaviours that were fixed last and had no test at all: a
 * client-declared `max_uses` per tool kind, nested usage blocks, a client
 * pinning its *own* tool through `tool_choice`, and the id pairing between an
 * assistant tool call and its result.
 */
let outcomeCalls = 0;
let closingCalls = 0;

describe('server tool budgets and wire shape', () => {
  const bothDeclarations = (searchUses: number, fetchUses: number) =>
    rewriteServerTools({
      declarations: { fetch: true, search: true },
      fetchProvider: makeFetchProvider(),
      searchProvider: makeSearchProvider(),
      tools: [
        { type: SEARCH_TYPE, name: 'web_search', max_uses: searchUses },
        { type: FETCH_TYPE, name: 'web_fetch', max_uses: fetchUses },
      ],
    });

  it('reads max_uses per declared tool, not one merged number', () => {
    const rewrite = bothDeclarations(8, 2);

    // The fetch's budget used to cap the searches too.
    expect(rewrite?.maxUses).toEqual({ web_fetch: 2, web_search: 8 });
  });

  it('clamps an absurd declared budget', () => {
    const rewrite = rewriteServerTools({
      declarations: { fetch: false, search: true },
      fetchProvider: null,
      searchProvider: makeSearchProvider(),
      tools: [{ type: SEARCH_TYPE, name: 'web_search', max_uses: 5000 }],
    });

    // Every use is a sequential upstream round trip, so this has to be bounded.
    expect(rewrite?.maxUses.web_search).toBeLessThanOrEqual(20);
  });

  it('leaves a tool_choice naming the client’s own WebSearch alone', async () => {
    const sentBodies: ChatRequestBody[] = [];
    let calls = 0;

    await runServerToolTurn({
      body: {
        ...body,
        tools: [
          { type: SEARCH_TYPE, name: 'web_search', max_uses: 8 },
          { name: 'WebSearch', input_schema: {}, type: 'function' },
        ],
        tool_choice: { type: 'function', function: { name: 'WebSearch' } },
      } as never,
      callUpstream: async (nextBody) => {
        sentBodies.push(nextBody);
        calls += 1;

        return calls === 1
          ? makeJsonResponse(assistantToolCall('web_search', '{"query":"q"}'))
          : makeJsonResponse({ choices: [] });
      },
      fetchProvider: null,
      // The same tool set: the client's `WebSearch` is what makes the respelled
      // spelling unsafe to claim, so it has to be part of the rewrite too.
      rewrite: rewriteServerTools({
        declarations: { fetch: false, search: true },
        fetchProvider: null,
        searchProvider: makeSearchProvider(),
        tools: [
          { type: SEARCH_TYPE, name: 'web_search', max_uses: 8 },
          { name: 'WebSearch', input_schema: {}, type: 'function' },
        ],
      }),
      searchProvider: makeSearchProvider(),
    });

    // Loosening this would stop the model calling the tool the client pinned.
    expect(sentBodies[1]?.tool_choice).toEqual({
      type: 'function',
      function: { name: 'WebSearch' },
    });
  });

  it('pairs each assistant tool call with its result, id included', async () => {
    let calls = 0;
    const sent: ChatRequestBody[] = [];

    await runServerToolTurn({
      body,
      callUpstream: async (nextBody) => {
        sent.push(nextBody);
        calls += 1;

        return calls === 1
          ? makeJsonResponse({
              choices: [
                {
                  finish_reason: 'tool_calls',
                  message: {
                    content: null,
                    role: 'assistant',
                    // No id: this is the case the fallback exists for.
                    tool_calls: [
                      {
                        type: 'function',
                        function: {
                          arguments: '{"query":"q"}',
                          name: 'web_search',
                        },
                      },
                    ],
                  },
                },
              ],
            })
          : makeJsonResponse({ choices: [] });
      },
      fetchProvider: null,
      rewrite: makeRewrite(makeSearchProvider()),
      searchProvider: makeSearchProvider(),
    });

    const assistant = sent[1]?.messages?.find(
      (message: { role?: string }) => message.role === 'assistant',
    ) as { tool_calls?: Array<{ id?: string }> } | undefined;
    const tool = sent[1]?.messages?.find(
      (message: { role?: string }) => message.role === 'tool',
    ) as { tool_call_id?: string } | undefined;

    // An assistant call with no id behind it cannot be paired by upstream.
    expect(assistant?.tool_calls?.[0]?.id).toBeTruthy();
    expect(tool?.tool_call_id).toBe(assistant?.tool_calls?.[0]?.id);
  });

  it('sums nested usage blocks across hops', async () => {
    const nested = (cached: number) => ({
      prompt_tokens: 10,
      prompt_tokens_details: { cached_tokens: cached },
    });

    outcomeCalls = 0;
    const outcome = await runServerToolTurn({
      body,
      callUpstream: async () => {
        const call = assistantToolCall('web_search', '{"query":"q"}');
        const hop = outcomeCalls++ === 0 ? call : { choices: [] };

        return makeJsonResponse({ ...hop, usage: nested(5) });
      },
      fetchProvider: null,
      rewrite: makeRewrite(makeSearchProvider()),
      searchProvider: makeSearchProvider(),
    });

    // The nested block used to be replaced by the last hop's, halving it.
    expect(outcome.usage).toEqual({
      prompt_tokens: 20,
      prompt_tokens_details: { cached_tokens: 10 },
    });
  });
});

/**
 * What has to survive a hop that goes wrong. The searches have already run and
 * been billed by then, and the proxy's own server-tool function must never
 * reach the client: the client declared a *provider-executed* tool, so it has
 * no handler for the name at all.
 */
describe('a hop that goes wrong', () => {
  const searchOnly = (maxUses: number) =>
    rewriteServerTools({
      declarations: { fetch: false, search: true },
      fetchProvider: null,
      searchProvider: makeSearchProvider(),
      tools: [{ type: SEARCH_TYPE, name: 'web_search', max_uses: maxUses }],
    });

  /**
   * A failure carrying both an `error` and a call that will never be answered.
   * Handing the payload through as it arrived gave the client a `tool_use` for
   * the proxy's internal `web_search` — a tool it never declared — and a finish
   * reason that made it wait for a result that was never coming.
   */
  it('hands a failed hop back with none of the proxy’s own calls', async () => {
    const outcome = await runServerToolTurn({
      body,
      callUpstream: async () =>
        makeJsonResponse({
          ...assistantToolCall('web_search', '{"query":"q"}'),
          error: { message: 'upstream exploded' },
        }),
      fetchProvider: null,
      rewrite: makeRewrite(makeSearchProvider()),
      searchProvider: makeSearchProvider(),
    });

    await expect(outstandingCalls(outcome.response)).resolves.toEqual({
      finishReason: 'stop',
      names: [],
    });
  });

  it('does so on a failed closing call too, keeping the search that ran', async () => {
    let calls = 0;
    const outcome = await runServerToolTurn({
      body,
      callUpstream: async () => {
        calls += 1;

        return calls === 1
          ? makeJsonResponse(assistantToolCall('web_search', '{"query":"q"}'))
          : makeJsonResponse({
              ...assistantToolCall('web_search', '{"query":"q"}', 'call_2'),
              error: { message: 'rate limited' },
            });
      },
      fetchProvider: null,
      // One use, so the closing call comes straight after the first search.
      rewrite: searchOnly(1),
      searchProvider: makeSearchProvider(),
    });

    // Billed before the failure, and not lost with it.
    expect(outcome.executions).toHaveLength(1);
    await expect(outstandingCalls(outcome.response)).resolves.toEqual({
      finishReason: 'stop',
      names: [],
    });
  });

  /**
   * Every other hop reads its body through a guard that turns an unparseable
   * body into an error; the closing call used to read it directly and threw,
   * discarding every search the turn had already run and paid for.
   */
  it('keeps the searches when the closing call answers with a body that will not parse', async () => {
    let calls = 0;
    const outcome = await runServerToolTurn({
      body,
      callUpstream: async () => {
        calls += 1;

        return calls < 3
          ? makeJsonResponse(
              assistantToolCall(
                'web_search',
                `{"query":"q${calls}"}`,
                `call_${calls}`,
              ),
            )
          : makeHtmlResponse();
      },
      fetchProvider: null,
      rewrite: searchOnly(2),
      searchProvider: makeSearchProvider(),
    });

    // Two searches and the closing call that failed to speak JSON: resolving at
    // all is the point, and the turn must not have asked again.
    expect(calls).toBe(3);
    expect(outcome.executions).toHaveLength(2);
    // Still recoverable from the response, which is where the Responses path
    // reads them from.
    expect(getServerToolExecutions(outcome.response)).toHaveLength(2);
    const payload = (await outcome.response.json()) as {
      error?: { message?: string };
    };

    // Surfaced as a failure rather than swallowed.
    expect(payload.error?.message).toBeTruthy();
  });
});

/**
 * Every hop is an upstream round trip and every search a backend call, so a
 * client that hangs up mid-turn should not be charged for the rest of the
 * budget it declared.
 */
describe('a client that hangs up', () => {
  const answerHop = (text = 'done'): Record<string, unknown> => ({
    choices: [
      { finish_reason: 'stop', message: { content: text, role: 'assistant' } },
    ],
  });

  const rewriteWithBudget = (
    searchProvider: WebSearchProvider,
    maxUses: number,
  ) =>
    rewriteServerTools({
      declarations: { fetch: false, search: true },
      fetchProvider: null,
      searchProvider,
      tools: [{ type: SEARCH_TYPE, name: 'web_search', max_uses: maxUses }],
    })!;

  /**
   * Aborts once `abortAfter` upstream calls have answered, so the hop that
   * produced the last one completes in full and the next checkpoint is where
   * the turn stops spending.
   */
  const hangingUpTurn = ({
    abortAfter,
    hops,
    maxUses = 5,
  }: {
    abortAfter: number;
    hops: Array<Record<string, unknown>>;
    maxUses?: number;
  }) => {
    const controller = new AbortController();
    let calls = 0;
    let searches = 0;

    const searchProvider: WebSearchProvider = {
      id: 'hangup-search',
      search: async () => {
        searches += 1;

        return { content: 'findings', results: [] };
      },
    };

    const run = (): Promise<ServerToolTurnOutcome> =>
      runServerToolTurn({
        body,
        callUpstream: async () => {
          calls += 1;

          if (calls > 25) {
            throw new Error(
              `the turn did not terminate: ${calls} upstream calls`,
            );
          }

          const response = makeJsonResponse(
            hops[Math.min(calls - 1, hops.length - 1)],
          );

          if (calls === abortAfter) {
            controller.abort();
          }

          return response;
        },
        fetchProvider: null,
        rewrite: rewriteWithBudget(searchProvider, maxUses),
        searchProvider,
        signal: controller.signal,
      });

    return { calls: () => calls, run, searches: () => searches };
  };

  it('spends nothing when the caller is already gone', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;

    const outcome = await runServerToolTurn({
      body,
      callUpstream: async () => {
        calls += 1;

        return makeJsonResponse(answerHop());
      },
      fetchProvider: null,
      rewrite: makeRewrite(makeSearchProvider()),
      searchProvider: makeSearchProvider(),
      signal: controller.signal,
    });

    expect(calls).toBe(0);
    expect(outcome.executions).toHaveLength(0);
    // Non-ok, so every caller stops rendering rather than emitting an answer
    // nobody is listening for.
    expect(outcome.response.ok).toBe(false);
  });

  it('stops asking upstream after the caller leaves', async () => {
    const { calls, run, searches } = hangingUpTurn({
      abortAfter: 1,
      hops: [assistantToolCall('web_search', '{"query":"q"}'), answerHop()],
    });

    await run();

    // The hop was already in flight when the caller left, so it cannot be
    // recalled any cheaper than letting it finish — but it runs nothing, and
    // nothing follows it.
    expect(calls()).toBe(1);
    expect(searches()).toBe(0);
  });

  it('does not spend the closing call once the caller leaves', async () => {
    // One search is the whole budget, so hop 1 leaves the turn ready to make
    // its closing call. That call is the next thing to skip.
    const { calls, run } = hangingUpTurn({
      abortAfter: 1,
      hops: [assistantToolCall('web_search', '{"query":"q"}'), answerHop()],
      maxUses: 1,
    });

    await run();

    expect(calls()).toBe(1);
  });

  it('keeps the searches it already ran', async () => {
    const { run, searches } = hangingUpTurn({
      abortAfter: 2,
      hops: [
        assistantToolCall('web_search', '{"query":"q"}'),
        assistantToolCall('web_search', '{"query":"q2"}'),
        answerHop(),
      ],
    });

    const outcome = await run();

    // Hop 1's search ran before the caller left. Hop 2's was still owed when
    // they went, so it is not executed and billed on their behalf.
    expect(searches()).toBe(1);
    expect(outcome.executions).toHaveLength(1);
    // Still recoverable from the response, which is where the Responses path
    // reads them from: it really ran and was really billed.
    expect(getServerToolExecutions(outcome.response)).toHaveLength(1);
  });

  /**
   * Consistent with every other way out of the turn: the internal function is
   * never handed to the client, not even when the turn is cut short. A
   * `tool_use` for a `web_search` the client never declared is a call it has
   * no handler for.
   */
  it('hands back no server-tool call the client would have to resolve', async () => {
    const { run } = hangingUpTurn({
      abortAfter: 1,
      hops: [assistantToolCall('web_search', '{"query":"q"}'), answerHop()],
    });

    const outcome = await run();
    const payload = (await outcome.response.json()) as {
      choices?: Array<{ message?: { tool_calls?: unknown[] } }>;
    };

    expect(payload.choices?.[0]?.message?.tool_calls ?? []).toEqual([]);
  });

  it('runs to completion when no signal is given', async () => {
    let calls = 0;

    const outcome = await runServerToolTurn({
      body,
      callUpstream: async () => {
        calls += 1;

        return makeJsonResponse(
          calls === 1
            ? assistantToolCall('web_search', '{"query":"q"}')
            : answerHop('It shipped yesterday.'),
        );
      },
      fetchProvider: null,
      rewrite: makeRewrite(makeSearchProvider()),
      searchProvider: makeSearchProvider(),
    });

    expect(calls).toBe(2);
    expect(outcome.response.ok).toBe(true);
  });
});
