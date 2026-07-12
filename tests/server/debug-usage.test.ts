import fs from 'node:fs';
import path from 'node:path';

import { createAccessKey } from '@/lib/server/domain/access-keys';
import {
  clearDebugLogs,
  createDebugTrace,
  enqueueUpstreamResponseSnapshot,
  finalizeDebugTrace,
  getDebugSettings,
  isDebugEnabled,
  listDebugLogs,
  setDebugTraceError,
  setDebugUpstreamRequest,
  updateDebugSettings,
} from '@/lib/server/domain/debug';
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

describe('debug and usage persistence', () => {
  beforeEach(() => {
    cleanupTempState();
    resetCredentialRuntimeState();
    vi.restoreAllMocks();
    vi.spyOn(process, 'cwd').mockReturnValue(tempRootDir);
    delete process.env.CODEBUDDY_STORAGE_FILE_DIR;
    delete process.env.CODEBUDDY_CONFIG_PATH;
  });

  afterEach(() => {
    cleanupTempState();
  });

  it('normalizes debug settings and handles invalid persisted files', async () => {
    expect(await getDebugSettings()).toEqual({
      autoRefreshSeconds: 0,
      enabled: false,
      maxEntries: 100,
    });
    expect(await isDebugEnabled()).toBe(false);

    fs.mkdirSync(tempDataDir, { recursive: true });
    fs.writeFileSync(debugConfigPath, '{');
    expect(await getDebugSettings()).toEqual({
      autoRefreshSeconds: 0,
      enabled: false,
      maxEntries: 100,
    });

    writeJson(debugConfigPath, {
      autoRefreshSeconds: 7,
      enabled: 'yes',
      maxEntries: -10,
    });
    expect(await getDebugSettings()).toEqual({
      autoRefreshSeconds: 0,
      enabled: false,
      maxEntries: 100,
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
      maxEntries: 100,
    });
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
    enqueueUpstreamResponseSnapshot(
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
    finalizeDebugTrace(
      trace,
      new Response('plain response', {
        headers: {
          'Content-Type': 'text/plain',
          'Set-Cookie': 'session=secret',
        },
        status: 201,
      }),
    );

    await vi.waitFor(async () => {
      expect(await listDebugLogs()).toHaveLength(1);
    });

    const [entry] = await listDebugLogs();
    expect(entry.error).toBe('upstream warning');
    expect(entry.requestKey).not.toBe('request-key-secret');
    expect(entry.requestBody).toMatchObject({
      nested: {
        api_key: 'shor****',
      },
      prompt: 'hello',
    });
    expect(entry.upstreamRequest).toMatchObject({
      body: {
        bearer_token: 'toke****',
      },
      method: 'POST',
    });
    expect(entry.upstreamRequest?.headers.Authorization).toContain('...');
    expect(entry.upstreamRequest?.headers['X-API-Key']).toBe('api-key-...alue');
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

    finalizeDebugTrace(undefined, new Response('ignored'));
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

    finalizeDebugTrace(firstTrace, Response.json({ ok: true }));
    finalizeDebugTrace(secondTrace, Response.json({ ok: true }));

    await vi.waitFor(async () => {
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
      (await getUsageAnalytics({ range: 'today' })).todaySummary.callCount,
    ).toBe(2);
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
    expect(analytics.todaySummary).toEqual({
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

    const filtered = await getUsageAnalytics({
      accessKey: accessKey.access_key.id,
      credential: credential.filename,
      now,
      range: 'today',
    });
    expect(filtered.tableRows).toHaveLength(1);
    expect(filtered.tableRows[0].model).toBe('gpt-5.5');
    expect(filtered.callSeries[0].points).toHaveLength(24);
    expect(filtered.tokenSeries[0].points).toHaveLength(24);

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
