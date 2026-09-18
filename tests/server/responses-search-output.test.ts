import fs from 'node:fs';
import path from 'node:path';

import { NextRequest } from 'next/server';

import { updateSettings } from '@/lib/server/domain/config';
import {
  addCredential,
  resetCredentialRuntimeState,
} from '@/lib/server/domain/credentials';
import { handleResponsesRequest } from '@/lib/server/proxy/responses';
import { resetWebSearchProviders } from '@/lib/server/search';

/**
 * The citations a Responses client reads off `output_text`.
 *
 * Real OpenAI emits a `url_citation` annotation per source so the client can
 * render links against the prose. This proxy runs the search itself and the
 * results never reached the response, so a client had nothing to show.
 */
describe('responses search output', () => {
  const tempRootDir = path.join(process.cwd(), '.tmp-responses-citations-root');
  const tempDataDir = path.join(tempRootDir, '.codebuddy_data');

  const SEARXNG_ENV_NAMES = [
    'SEARXNG_URL',
    'SEARXNG_API_KEY',
    'SEARXNG_ENGINES',
    'SEARXNG_LANGUAGE',
    'SEARXNG_MAX_RESULTS',
    'SEARXNG_TIMEOUT_MS',
  ] as const;

  /** An output item, as far as these tests read it. */
  interface OutputItem {
    content?: Array<Record<string, unknown>>;
    type: string;
  }

  /** A `url_citation`, as the Responses API spells it. */
  interface UrlCitation {
    end_index: number;
    start_index: number;
    title: string;
    type: string;
    url: string;
  }

  interface TurnPayload {
    output: OutputItem[];
    output_text: string;
  }

  const clearSearxngEnv = (): void => {
    for (const name of SEARXNG_ENV_NAMES) {
      delete process.env[name];
    }

    resetWebSearchProviders();
  };

  const cleanupDir = (): void => {
    fs.rmSync(tempRootDir, { force: true, recursive: true, maxRetries: 5 });
  };

  const makeJsonResponse = (
    payload: Record<string, unknown>,
    status = 200,
  ): Response =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  const makeRequest = (): NextRequest =>
    new NextRequest('http://localhost/v1/responses', {
      method: 'POST',
      headers: { authorization: 'Bearer responses-citations-token' },
    });

  const enableSearch = async (): Promise<void> => {
    process.env.SEARXNG_URL = 'https://searx.test';
    resetWebSearchProviders();
    await updateSettings({ CODEBUDDY_WEB_SEARCH_BACKEND: 'searxng' });
  };

  const searchHop = (content: string | null) => ({
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          content,
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: {
                arguments: '{"query":"release date"}',
                name: 'web_search',
              },
            },
          ],
        },
      },
    ],
  });

  const answerHop = (text: string) => ({
    choices: [
      { finish_reason: 'stop', message: { content: text, role: 'assistant' } },
    ],
  });

  /**
   * One turn: the model asks for a search, the proxy serves `results`, and the
   * model answers with `answer`.
   *
   * `tools` is what makes it a server-tool turn — the proxy only runs a search
   * for a provider-executed declaration, so a request that declares none never
   * reaches the backend at all.
   */
  interface TurnOptions {
    answer: string;
    /** Text the model writes before it searches, when it writes any. */
    preamble?: string;
    results: Array<Record<string, unknown>>;
    tools?: Array<Record<string, unknown>>;
  }

  const runTurn = async ({
    answer,
    preamble,
    results,
    tools = [{ type: 'web_search_preview' }],
  }: TurnOptions): Promise<TurnPayload> => {
    let calls = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);

      if (url.includes('searx.test')) {
        return makeJsonResponse({ results }) as unknown as Response;
      }

      calls += 1;

      return makeJsonResponse(
        calls === 1 && tools.length
          ? searchHop(preamble ?? null)
          : answerHop(answer),
      ) as unknown as Response;
    });

    const response = await handleResponsesRequest(makeRequest(), {
      input: 'when did it ship?',
      model: 'glm-5.1',
      tools,
    });

    return (await response.json()) as TurnPayload;
  };

  /** Every assistant message, in the order it was written. */
  const messages = (payload: TurnPayload): OutputItem[] =>
    payload.output.filter((item) => item.type === 'message');

  /** The annotations on one message; the last one unless told otherwise. */
  const annotationsOf = (
    payload: TurnPayload,
    messageIndex = -1,
  ): UrlCitation[] =>
    (messages(payload).at(messageIndex)?.content?.[0]?.annotations ??
      []) as UrlCitation[];

  beforeEach(async () => {
    clearSearxngEnv();
    resetCredentialRuntimeState();
    cleanupDir();
    fs.mkdirSync(tempDataDir, { recursive: true });
    vi.spyOn(process, 'cwd').mockReturnValue(tempRootDir);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    process.env.CODEBUDDY_AUTH_MODE = 'auto';
    await addCredential({
      bearer_token: 'responses-citations-token',
      responses_passthrough: false,
      user_id: 'responses-citations@example.com',
    });
  });

  afterEach(() => {
    clearSearxngEnv();
    cleanupDir();
    vi.restoreAllMocks();
  });

  it('cites the result whose URL the model quoted, over exactly that span', async () => {
    await enableSearch();

    const payload = await runTurn({
      answer: 'It shipped yesterday — see https://docs.test/release for notes.',
      results: [
        {
          content: 'A snippet',
          title: 'Docs',
          url: 'https://docs.test/release',
        },
      ],
    });

    const annotations = annotationsOf(payload);

    expect(annotations).toEqual([
      {
        end_index: 'It shipped yesterday — see https://docs.test/release'
          .length,
        start_index: 'It shipped yesterday — see '.length,
        title: 'Docs',
        type: 'url_citation',
        url: 'https://docs.test/release',
      },
    ]);
    // End-exclusive, and nothing but the URL it points at.
    expect(
      payload.output_text.slice(
        annotations[0].start_index,
        annotations[0].end_index,
      ),
    ).toBe('https://docs.test/release');
  });

  it('invents nothing for a result the model never quoted', async () => {
    await enableSearch();

    const payload = await runTurn({
      answer: 'It shipped yesterday, apparently.',
      results: [
        {
          content: 'A snippet',
          title: 'Docs',
          url: 'https://docs.test/release',
        },
      ],
    });

    // The search still ran, so the call item is there — but nothing in the
    // answer points at a source, so no span can be claimed.
    expect(payload.output.map((item) => item.type)).toContain(
      'web_search_call',
    );
    expect(annotationsOf(payload)).toEqual([]);
  });

  it('orders two cited URLs by start_index', async () => {
    await enableSearch();

    const payload = await runTurn({
      answer: 'See https://b.test/second and https://a.test/first.',
      results: [
        { content: 'one', title: 'First', url: 'https://a.test/first' },
        { content: 'two', title: 'Second', url: 'https://b.test/second' },
      ],
    });

    const annotations = annotationsOf(payload);

    // The second result is quoted first, so it is annotated first.
    expect(annotations).toEqual([
      {
        end_index: 'See https://b.test/second'.length,
        start_index: 'See '.length,
        title: 'Second',
        type: 'url_citation',
        url: 'https://b.test/second',
      },
      {
        end_index: 'See https://b.test/second and https://a.test/first'.length,
        start_index: 'See https://b.test/second and '.length,
        title: 'First',
        type: 'url_citation',
        url: 'https://a.test/first',
      },
    ]);
  });

  it('leaves the preamble unannotated', async () => {
    await enableSearch();

    const payload = await runTurn({
      answer: 'Here is what I found: https://docs.test/release.',
      preamble: 'Let me check https://docs.test/release.',
      results: [
        {
          content: 'A snippet',
          title: 'Docs',
          url: 'https://docs.test/release',
        },
      ],
    });

    const all = messages(payload);

    // Two: what was written before the search, and the answer after it.
    expect(all).toHaveLength(2);
    expect(all[0].content?.[0]?.text).toBe(
      'Let me check https://docs.test/release.',
    );
    // Prose written before the search cannot cite it, even when it quotes a
    // URL that later turns out to be a result.
    expect(annotationsOf(payload, 0)).toEqual([]);
    expect(annotationsOf(payload)).toHaveLength(1);
  });

  it('annotates nothing when no search ran', async () => {
    await enableSearch();

    const payload = await runTurn({
      answer: 'It shipped in March, as I recall.',
      results: [],
      tools: [],
    });

    expect(payload.output.map((item) => item.type)).toEqual(['message']);
    expect(annotationsOf(payload)).toEqual([]);
  });
});
