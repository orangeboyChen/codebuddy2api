import fs from 'node:fs';
import path from 'node:path';

import { createAccessKey } from '@/lib/server/domain/access-keys';
import {
  clearDebugLogs,
  createDebugTrace,
  enqueueUpstreamResponseSnapshot,
  finalizeDebugTrace,
  getDebugSettings,
  hasPendingDebugLogWrites,
  isDebugEnabled,
  listDebugLogs,
  setDebugTraceError,
  setDebugUpstreamRequest,
  updateDebugSettings,
} from '@/lib/server/domain/debug';
import type { DebugTrace } from '@/lib/server/domain/debug';
import {
  addCredential,
  resetCredentialRuntimeState,
} from '@/lib/server/domain/credentials';
import {
  clearUsageHistory,
  getUsageAnalytics,
  recordUsageEvent,
  resetUsageHistory,
} from '@/lib/server/domain/usage';
import { resetStorageRuntime, writeStorageJson } from '@/lib/server/storage';

const repoRoot = process.cwd();
const tempRootDir = path.join(repoRoot, '.tmp-test-debug-usage-root');
const tempDataDir = path.join(tempRootDir, '.codebuddy_data');
const debugConfigPath = path.join(tempDataDir, 'debug-settings.json');
const debugLogsPath = path.join(tempDataDir, 'debug-logs.json');
const usagePath = path.join(tempDataDir, 'usage-history.json');

const cleanupTempState = (): void => {
  fs.rmSync(tempRootDir, { force: true, recursive: true });
};

const writeJson = (filePath: string, value: unknown): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
};

const enqueueAndConsumeUpstreamSnapshot = async (
  trace: DebugTrace | undefined,
  response: Response,
): Promise<void> => {
  await enqueueUpstreamResponseSnapshot(trace, response).text();
};

const finalizeAndConsumeDebugTrace = async (
  trace: DebugTrace | undefined,
  response: Response,
): Promise<void> => {
  await finalizeDebugTrace(trace, response).text();
};

const waitForDebugLogs = async (
  assertion: () => Promise<void>,
): Promise<void> => {
  await vi.waitFor(assertion, { timeout: 2_000 });
};

describe('debug and usage persistence', () => {
  beforeEach(() => {
    cleanupTempState();
    resetCredentialRuntimeState();
    vi.restoreAllMocks();
    vi.spyOn(process, 'cwd').mockReturnValue(tempRootDir);
    delete process.env.CODEBUDDY_STORAGE_FILE_DIR;
    delete process.env.CODEBUDDY_CONFIG_PATH;
    delete process.env.CODEBUDDY_STORAGE_BACKEND;
    delete process.env.CODEBUDDY_STORAGE_ENCRYPTION_KEY;
    delete process.env.CODEBUDDY_STORAGE_IMPORT_LEGACY_FILES;
    delete process.env.CODEBUDDY_STORAGE_SQLITE_PATH;
    resetStorageRuntime();
  });

  afterEach(() => {
    cleanupTempState();
  });

  it('stores a masked bearer request key without its auth scheme', () => {
    const trace = createDebugTrace({
      requestBody: {},
      requestKey: 'Bearer sk-live-abcdefgh1234',
      route: '/v1/chat/completions',
    });

    expect(trace.requestKey).toBe('sk-live-********1234');
    expect(trace.requestKey).not.toContain('Bearer');

    const shortTrace = createDebugTrace({
      requestBody: { api_key: 'abc' },
      requestKey: 'abc',
      route: '/v1/chat/completions',
    });

    expect(shortTrace.requestKey).toBe('****');
    expect(shortTrace.requestBody).toMatchObject({ api_key: '****' });

    expect(
      createDebugTrace({
        requestBody: {},
        requestKey: 'Bearer abc',
        route: '/v1/chat/completions',
      }).requestKey,
    ).toBe('****');
  });

  it('captures terminal upstream stream states without delaying the response', async () => {
    const consumeSnapshot = async (response: Response): Promise<DebugTrace> => {
      const trace = createDebugTrace({
        requestBody: {},
        requestKey: null,
        route: '/v1/chat/completions',
      });
      await enqueueUpstreamResponseSnapshot(trace, response).text();
      await Promise.all(trace.pending);
      return trace;
    };

    const truncated = await consumeSnapshot(
      new Response(`${'a'.repeat(200_000)}tail`),
    );
    expect(truncated.upstreamResponse?.body).toMatch(
      /^a+\n\.\.\.\[truncated\]$/,
    );

    const empty = await consumeSnapshot(new Response(null));
    expect(empty.upstreamResponse?.body).toBe('');

    const cancellableTrace = createDebugTrace({
      requestBody: {},
      requestKey: null,
      route: '/v1/chat/completions',
    });
    const cancellable = enqueueUpstreamResponseSnapshot(
      cancellableTrace,
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('partial'));
          },
        }),
      ),
    );
    const cancellableReader = cancellable.body?.getReader();
    await cancellableReader?.read();
    await cancellableReader?.cancel();
    await Promise.all(cancellableTrace.pending);
    expect(cancellableTrace.upstreamResponse?.body).toBe('partial');

    const errorTrace = createDebugTrace({
      requestBody: {},
      requestKey: null,
      route: '/v1/chat/completions',
    });
    const failing = enqueueUpstreamResponseSnapshot(
      errorTrace,
      new Response(
        new ReadableStream<Uint8Array>({
          pull() {
            throw new Error('upstream stream failure');
          },
        }),
      ),
    );
    await expect(failing.text()).rejects.toThrow('upstream stream failure');
    await Promise.all(errorTrace.pending);
    expect(errorTrace.upstreamResponse?.body).toBe('');
  });

  it('normalizes debug settings and handles invalid persisted files', async () => {
    expect(await getDebugSettings()).toEqual({
      autoRefreshSeconds: 0,
      enabled: false,
      maxEntries: 10,
    });
    expect(await isDebugEnabled()).toBe(false);

    fs.mkdirSync(tempDataDir, { recursive: true });
    fs.writeFileSync(debugConfigPath, '{');
    expect(await getDebugSettings()).toEqual({
      autoRefreshSeconds: 0,
      enabled: false,
      maxEntries: 10,
    });

    writeJson(debugConfigPath, {
      autoRefreshSeconds: 7,
      enabled: 'yes',
      maxEntries: -10,
    });
    expect(await getDebugSettings()).toEqual({
      autoRefreshSeconds: 0,
      enabled: false,
      maxEntries: 10,
    });

    expect(
      await updateDebugSettings({
        autoRefreshSeconds: 15,
        enabled: true,
        maxEntries: 5000,
      }),
    ).toEqual({
      autoRefreshSeconds: 15,
      enabled: true,
      maxEntries: 1000,
    });
    expect(await isDebugEnabled()).toBe(true);

    expect(
      await updateDebugSettings({
        autoRefreshSeconds: -1,
        maxEntries: Number.NaN,
      }),
    ).toEqual({
      autoRefreshSeconds: 0,
      enabled: true,
      maxEntries: 10,
    });
  });

  it('refreshes the debug-enabled cache after its short TTL', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-19T00:00:00.000Z'));

    try {
      await updateDebugSettings({ enabled: true });
      expect(await isDebugEnabled()).toBe(true);

      await writeStorageJson('debug', 'settings', {
        autoRefreshSeconds: 0,
        enabled: false,
        maxEntries: 10,
      });
      expect(await isDebugEnabled()).toBe(true);

      await vi.advanceTimersByTimeAsync(1000);
      expect(await isDebugEnabled()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('captures sanitized debug request and response snapshots', async () => {
    await updateDebugSettings({
      enabled: true,
      maxEntries: 1,
    });
    const trace = createDebugTrace({
      requestBody: {
        nested: {
          api_key: 'short-secret',
          token: 'very-long-secret-token',
        },
        prompt: 'hello',
      },
      requestKey: 'request-key-secret',
      route: '/v1/responses',
    });

    setDebugTraceError(undefined, new Error('ignored'));
    setDebugTraceError(trace, 'upstream warning');
    setDebugUpstreamRequest(undefined, {
      body: null,
      headers: {},
      method: 'POST',
      url: 'https://example.com',
    });
    setDebugUpstreamRequest(trace, {
      body: {
        bearer_token: 'token-value',
        messages: ['hello'],
      },
      headers: {
        Authorization: 'Bearer top-secret-token',
        'Content-Type': 'application/json',
        'X-API-Key': 'api-key-value',
      },
      method: 'POST',
      url: 'https://example.com/v2/chat/completions',
    });

    enqueueUpstreamResponseSnapshot(undefined, new Response('ignored'));
    await enqueueAndConsumeUpstreamSnapshot(
      trace,
      Response.json(
        {
          access_token: 'response-token',
          result: 'ok',
        },
        {
          headers: {
            Authorization: 'Bearer response-secret',
          },
          status: 202,
        },
      ),
    );
    await finalizeAndConsumeDebugTrace(
      trace,
      new Response('plain response', {
        headers: {
          'Content-Type': 'text/plain',
          'Set-Cookie': 'session=secret',
        },
        status: 201,
      }),
    );

    await waitForDebugLogs(async () => {
      expect(await listDebugLogs()).toHaveLength(1);
    });

    const [entry] = await listDebugLogs();
    expect(entry.error).toBe('upstream warning');
    expect(entry.requestKey).not.toBe('request-key-secret');
    expect(entry.requestBody).toMatchObject({
      nested: {
        api_key: 'shor********',
      },
      prompt: 'hello',
    });
    expect(entry.upstreamRequest).toMatchObject({
      body: {
        bearer_token: 'toke*******',
      },
      method: 'POST',
    });
    expect(entry.upstreamRequest?.headers.Authorization).toContain('****');
    expect(entry.upstreamRequest?.headers['X-API-Key']).toBe('api-key-*alue');
    expect(entry.upstreamResponse).toMatchObject({
      body: {
        access_token: expect.not.stringContaining('response-token'),
        result: 'ok',
      },
      status: 202,
    });
    expect(entry.transformedResponse).toMatchObject({
      body: 'plain response',
      status: 201,
    });
    expect(entry).toMatchObject({
      elapsedMs: expect.any(Number),
      model: null,
      usage: null,
    });

    await finalizeAndConsumeDebugTrace(undefined, new Response('ignored'));
    await clearDebugLogs();
    expect(await listDebugLogs()).toEqual([]);

    writeJson(debugLogsPath, { logs: [] });
    expect(await listDebugLogs()).toEqual([]);
    writeJson(debugLogsPath, [
      null,
      {
        createdAt: '2026-07-11T00:00:00.000Z',
        id: 'valid-log',
        route: '/v1/models',
      },
    ]);
    expect(await listDebugLogs()).toHaveLength(1);
  });

  it('keeps pending traces out of reads until the background flush runs', async () => {
    vi.useFakeTimers();
    try {
      await updateDebugSettings({ enabled: true, maxEntries: 10 });
      const trace = createDebugTrace({
        requestBody: { model: 'gpt-5.5' },
        requestKey: null,
        route: '/v1/responses',
      });

      await enqueueAndConsumeUpstreamSnapshot(
        trace,
        Response.json({
          usage: {
            input_tokens: 3,
            output_tokens: 5,
            prompt_tokens_details: { cached_tokens: 2 },
          },
        }),
      );
      await finalizeAndConsumeDebugTrace(trace, new Response('completed'));

      await vi.runAllTicks();
      expect(hasPendingDebugLogWrites()).toBe(true);
      expect(await listDebugLogs()).toEqual([]);

      await vi.runAllTimersAsync();
      expect(hasPendingDebugLogWrites()).toBe(false);
      const [entry] = await listDebugLogs();
      expect(entry).toMatchObject({
        model: 'gpt-5.5',
        usage: {
          cacheCreationTokens: 0,
          cacheReadTokens: 2,
          inputTokens: 3,
          outputTokens: 5,
          totalTokens: 8,
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('truncates response snapshots while streaming to the client', async () => {
    await updateDebugSettings({ enabled: true, maxEntries: 10 });
    const trace = createDebugTrace({
      requestBody: {},
      requestKey: null,
      route: '/v1/responses',
    });

    await finalizeAndConsumeDebugTrace(
      trace,
      new Response(`${'a'.repeat(200_000)}tail`, {
        headers: { 'Content-Type': 'text/plain' },
      }),
    );

    await waitForDebugLogs(async () => {
      expect(await listDebugLogs()).toHaveLength(1);
    });
    const [entry] = await listDebugLogs();
    expect(entry.transformedResponse?.body).toMatch(
      /^a+\n\.\.\.\[truncated\]$/,
    );
    expect(entry.transformedResponse?.body).not.toContain('tail');
  });

  it('redacts sensitive fields in truncated JSON response snapshots', async () => {
    await updateDebugSettings({ enabled: true, maxEntries: 10 });
    const trace = createDebugTrace({
      requestBody: {},
      requestKey: null,
      route: '/v1/responses',
    });

    await finalizeAndConsumeDebugTrace(
      trace,
      new Response(
        JSON.stringify({
          access_token: 'snapshot-access-token',
          payload: 'a'.repeat(200_000),
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await waitForDebugLogs(async () => {
      expect(await listDebugLogs()).toHaveLength(1);
    });
    const [entry] = await listDebugLogs();
    const body = String(entry.transformedResponse?.body);
    expect(body).toContain('[redacted]');
    expect(body).not.toContain('snapshot-access-token');
  });

  it('redacts escaped sensitive keys in truncated JSON response snapshots', async () => {
    await updateDebugSettings({ enabled: true, maxEntries: 10 });
    const trace = createDebugTrace({
      requestBody: {},
      requestKey: null,
      route: '/v1/responses',
    });

    await finalizeAndConsumeDebugTrace(
      trace,
      new Response(
        `{"access\\u005ftoken":"escaped-snapshot-access-token","payload":"${'a'.repeat(200_000)}"}`,
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await waitForDebugLogs(async () => {
      expect(await listDebugLogs()).toHaveLength(1);
    });
    const [entry] = await listDebugLogs();
    const body = String(entry.transformedResponse?.body);
    expect(body).toContain('[redacted]');
    expect(body).not.toContain('escaped-snapshot-access-token');
  });

  it('returns the retained entry after flushing a full debug log', async () => {
    await updateDebugSettings({ enabled: true, maxEntries: 1 });
    const firstTrace = createDebugTrace({
      requestBody: { input: 'first' },
      requestKey: null,
      route: '/v1/chat/completions',
    });
    await finalizeAndConsumeDebugTrace(
      firstTrace,
      Response.json({ message: 'first' }),
    );

    await waitForDebugLogs(async () => {
      expect(await listDebugLogs()).toHaveLength(1);
    });

    const secondTrace = createDebugTrace({
      requestBody: { input: 'second' },
      requestKey: null,
      route: '/v1/chat/completions',
    });
    await finalizeAndConsumeDebugTrace(
      secondTrace,
      Response.json({ message: 'second' }),
    );

    await waitForDebugLogs(async () => {
      const logs = await listDebugLogs();
      expect(logs).toHaveLength(1);
      expect(logs[0]?.id).toBe(secondTrace.id);
    });
  });

  it('extracts usage from OpenAI streaming response events', async () => {
    await updateDebugSettings({ enabled: true, maxEntries: 10 });
    const trace = createDebugTrace({
      requestBody: { model: 'gpt-5.5' },
      requestKey: null,
      route: '/v1/chat/completions',
    });
    const stream =
      'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n' +
      'data: {"usage":{"prompt_tokens":3,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":2}}}\n\n' +
      'data: [DONE]\n\n';

    await enqueueAndConsumeUpstreamSnapshot(
      trace,
      new Response(stream, {
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
    await finalizeAndConsumeDebugTrace(
      trace,
      new Response(stream, {
        headers: { 'content-type': 'text/event-stream' },
      }),
    );

    await waitForDebugLogs(async () => {
      expect(await listDebugLogs()).toHaveLength(1);
    });
    const [entry] = await listDebugLogs();
    expect(entry.usage).toEqual({
      cacheCreationTokens: 0,
      cacheReadTokens: 2,
      inputTokens: 3,
      outputTokens: 5,
      totalTokens: 8,
    });
  });

  it('extracts usage from nested Responses API streaming events', async () => {
    await updateDebugSettings({ enabled: true, maxEntries: 10 });
    const trace = createDebugTrace({
      requestBody: { model: 'gpt-5.5' },
      requestKey: null,
      route: '/v1/responses',
    });
    const stream =
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":5,"cache_read_input_tokens":2}}}\n\n' +
      'data: [DONE]\n\n';

    await enqueueAndConsumeUpstreamSnapshot(
      trace,
      new Response(stream, {
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
    await finalizeAndConsumeDebugTrace(
      trace,
      new Response(stream, {
        headers: { 'content-type': 'text/event-stream' },
      }),
    );

    await waitForDebugLogs(async () => {
      expect(await listDebugLogs()).toHaveLength(1);
    });
    const [entry] = await listDebugLogs();
    expect(entry.usage).toEqual({
      cacheCreationTokens: 0,
      cacheReadTokens: 2,
      inputTokens: 3,
      outputTokens: 5,
      totalTokens: 10,
    });
  });

  it('serializes concurrent debug and usage persistence', async () => {
    await updateDebugSettings({ enabled: true, maxEntries: 2 });
    const firstTrace = createDebugTrace({
      requestBody: { input: 'first' },
      requestKey: null,
      route: '/v1/chat/completions',
    });
    const secondTrace = createDebugTrace({
      requestBody: { input: 'second' },
      requestKey: null,
      route: '/v1/responses',
    });

    await finalizeAndConsumeDebugTrace(firstTrace, Response.json({ ok: true }));
    await finalizeAndConsumeDebugTrace(
      secondTrace,
      Response.json({ ok: true }),
    );

    await waitForDebugLogs(async () => {
      expect(await listDebugLogs()).toHaveLength(2);
    });

    await Promise.all([
      recordUsageEvent({
        model: 'first',
        route: '/v1/chat/completions',
        usage: { total_tokens: 1 },
      }),
      recordUsageEvent({
        model: 'second',
        route: '/v1/responses',
        usage: { total_tokens: 1 },
      }),
    ]);

    expect(
      (await getUsageAnalytics({ range: 'today' })).rangeSummary.callCount,
    ).toBe(2);
  });

  it('uses append-only SQLite events for debug and usage records', async () => {
    process.env.CODEBUDDY_STORAGE_BACKEND = 'sqlite';
    process.env.CODEBUDDY_STORAGE_ENCRYPTION_KEY = 'storage-secret';
    process.env.CODEBUDDY_STORAGE_IMPORT_LEGACY_FILES = 'false';
    process.env.CODEBUDDY_STORAGE_SQLITE_PATH = path.join(
      tempRootDir,
      'events.sqlite',
    );
    vi.spyOn(process, 'cwd').mockReturnValue(repoRoot);
    resetStorageRuntime();

    await updateDebugSettings({ enabled: true, maxEntries: 10 });
    const trace = createDebugTrace({
      requestBody: { prompt: 'database event' },
      requestKey: null,
      route: '/v1/messages',
    });
    await finalizeAndConsumeDebugTrace(trace, Response.json({ ok: true }));

    await waitForDebugLogs(async () => {
      expect(await listDebugLogs()).toHaveLength(1);
    });

    await recordUsageEvent({
      model: 'sqlite-model',
      route: '/v1/messages',
      usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
    });
    expect(
      (await getUsageAnalytics({ range: 'today' })).rangeSummary,
    ).toMatchObject({ callCount: 1, totalTokens: 3 });

    await clearDebugLogs();
    await clearUsageHistory();
    resetStorageRuntime();
  });

  it('records usage, aggregates ranges, filters, and trims stale events', async () => {
    const now = new Date('2026-07-11T12:30:00.000Z');
    vi.spyOn(Date, 'now').mockReturnValue(now.getTime());

    const credential = await addCredential({
      bearer_token: 'usage-token',
      user_id: 'usage@example.com',
    });
    const accessKey = await createAccessKey({
      credentialFilenames: [credential.filename],
      name: 'Usage Key',
    });

    await recordUsageEvent({
      model: 'ignored',
      route: '/v1/models',
      usage: null,
    });
    await recordUsageEvent({
      accessKeyId: accessKey.access_key.id,
      accessKeyName: accessKey.access_key.name,
      credentialFilename: credential.filename,
      model: ' gpt-5.5 ',
      route: '/v1/responses',
      timestamp: '2026-07-11T12:05:00.000Z',
      usage: {
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 3,
        completion_tokens: 7,
        prompt_tokens: 11,
      },
    });
    await recordUsageEvent({
      credentialFilename: credential.filename,
      model: '',
      route: '/v1/chat/completions',
      timestamp: '2026-07-11T11:15:00.000Z',
      usage: {
        input_tokens: -1,
        output_tokens: '4' as unknown as number,
        total_tokens: 20,
      },
    });

    const analytics = await getUsageAnalytics({
      now,
      range: '3h',
    });
    expect(analytics.rangeSummary).toEqual({
      callCount: 2,
      cacheHitTokens: 3,
      totalTokens: 43,
    });
    expect(analytics.tableRows).toEqual([
      {
        cacheHitTokens: 3,
        callCount: 1,
        model: 'gpt-5.5',
        totalTokens: 23,
      },
      {
        cacheHitTokens: 0,
        callCount: 1,
        model: 'unknown',
        totalTokens: 20,
      },
    ]);
    expect(analytics.filters.accessKeys).toContainEqual({
      label: 'Usage Key',
      value: accessKey.access_key.id,
    });
    expect(analytics.filters.credentials).toContainEqual({
      label: credential.filename,
      value: credential.filename,
    });
    expect(analytics.tokenSeries).toHaveLength(2);
    expect(analytics.callSeries).toHaveLength(2);
    expect(analytics.credentialRows).toEqual([
      {
        cacheHitTokens: 3,
        callCount: 2,
        credentialFilename: credential.filename,
        totalTokens: 43,
      },
    ]);

    const filtered = await getUsageAnalytics({
      accessKey: [accessKey.access_key.id, 'missing-key'],
      credential: [credential.filename, 'missing-credential.json'],
      now,
      range: 'today',
    });
    expect(filtered.tableRows).toHaveLength(1);
    expect(filtered.tableRows[0].model).toBe('gpt-5.5');
    expect(filtered.callSeries[0].points).toHaveLength(24);
    expect(filtered.tokenSeries[0].points).toHaveLength(24);
    expect(filtered.rangeSummary).toEqual({
      cacheHitTokens: 3,
      callCount: 1,
      totalTokens: 23,
    });
    expect(filtered.credentialRows).toEqual([
      {
        cacheHitTokens: 3,
        callCount: 1,
        credentialFilename: credential.filename,
        totalTokens: 23,
      },
    ]);

    expect(
      (
        await getUsageAnalytics({
          accessKey: accessKey.access_key.id,
          credential: 'missing-credential.json',
          now,
          range: 'today',
        })
      ).rangeSummary,
    ).toEqual({
      cacheHitTokens: 0,
      callCount: 0,
      totalTokens: 0,
    });

    expect(
      (
        await getUsageAnalytics({
          now,
          range: 'yesterday',
        })
      ).tableRows,
    ).toEqual([]);
    expect(
      (
        await getUsageAnalytics({
          now,
          range: '3d',
        })
      ).tokenSeries,
    ).toHaveLength(2);

    const stored = JSON.parse(fs.readFileSync(usagePath, 'utf8')) as {
      events: unknown[];
    };
    writeJson(usagePath, {
      events: [
        ...stored.events,
        {
          accessKeyId: null,
          accessKeyName: null,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          callCount: 1,
          credentialFilename: null,
          inputTokens: 1,
          model: 'stale',
          outputTokens: 1,
          route: '/v1/models',
          timestamp: '2026-06-01T00:00:00.000Z',
          totalTokens: 2,
        },
        {
          model: 'invalid',
          route: '/v1/models',
          timestamp: 'not-a-date',
        },
      ],
    });
    expect(
      (
        await getUsageAnalytics({
          now,
          range: '7d',
        })
      ).tableRows.some((row) => row.model === 'stale'),
    ).toBe(false);

    await clearUsageHistory();
    expect(
      (
        await getUsageAnalytics({
          now,
          range: '1h',
        })
      ).tableRows,
    ).toEqual([]);
    await resetUsageHistory();
    expect(JSON.parse(fs.readFileSync(usagePath, 'utf8'))).toEqual({
      events: [],
    });

    fs.writeFileSync(usagePath, '{');
    expect(
      (
        await getUsageAnalytics({
          now,
          range: '24h',
        })
      ).tableRows,
    ).toEqual([]);
  });
});
