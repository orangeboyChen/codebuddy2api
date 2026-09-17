import fs from 'node:fs';
import path from 'node:path';

import { NextRequest } from 'next/server';

import { updateSettings } from '@/lib/server/domain/config';
import { isDebugEnabled, updateDebugSettings } from '@/lib/server/domain/debug';
import { resetWebSearchProviders } from '@/lib/server/search';
import { handleMessagesRequest } from '@/lib/server/proxy/anthropic';
import { proxyChatCompletions } from '@/lib/server/proxy/codebuddy';
import {
  addCredential,
  resetCredentialRuntimeState,
} from '@/lib/server/domain/credentials';
import { resetUsageStats } from '@/lib/server/domain/stats';
import { resetStorageRuntime } from '@/lib/server/storage';

/**
 * An upstream error response has to survive being inspected more than once.
 *
 * The server-tool loop reads the body to find out whether the model asked for a
 * search, `logUpstreamFailure` reads it to record what went wrong, and the
 * route layer reads it again to build the answer the client actually sees. A
 * `Response` body can only be consumed once, so those reads have to share:
 * every one of them after the first used to fail with
 * `Body already used`, which surfaced to clients as a 500 instead of the real
 * upstream status.
 */

const tempRootDir = path.join(process.cwd(), '.tmp-test-upstream-error-root');

const cleanupTempState = (): void => {
  fs.rmSync(tempRootDir, { force: true, recursive: true });
};

const makeNextRequest = (): NextRequest =>
  new NextRequest('http://localhost/v1/chat/completions', { method: 'POST' });

const makeJsonResponse = (
  payload: Record<string, unknown>,
  status = 200,
): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

describe('upstream error responses', () => {
  beforeEach(async () => {
    cleanupTempState();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.spyOn(process, 'cwd').mockReturnValue(tempRootDir);
    process.env.CODEBUDDY_AUTH_MODE = 'auto';
    process.env.CODEBUDDY_API_KEY = '';
    resetStorageRuntime();
    resetCredentialRuntimeState();
    await resetUsageStats();
    addCredential({
      bearer_token: 'error-path-token',
      user_id: 'error-path@example.com',
    });
  });

  afterEach(() => {
    cleanupTempState();
  });

  it('keeps the body readable after the failure has been logged', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeJsonResponse(
        {
          code: 6004,
          msg: '您的使用量已超出频率限制',
        },
        429,
      ),
    );

    const response = await proxyChatCompletions(
      makeNextRequest(),
      {
        model: 'glm-5.1',
        messages: [{ role: 'user', content: 'hello' }],
      },
      undefined,
      undefined,
    );

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      error: { detail: expect.stringContaining('6004') },
    });
  });

  it('surfaces the upstream status through the server-tool loop', async () => {
    // Reproduces the reported failure: a rate-limited upstream answering a
    // request that declared a server web tool. The loop reads the body to
    // decide whether the model asked for a search, and the route layer reads
    // it again to build the client's answer.
    process.env.SEARXNG_URL = 'https://searx.test';
    resetWebSearchProviders();
    await updateSettings({ CODEBUDDY_WEB_SEARCH_BACKEND: 'searxng' });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeJsonResponse(
        {
          code: 6004,
          msg: '您的使用量已超出频率限制，将在 2026-09-18 11:35:06 UTC+8 重置',
          requestId: '5d3bd1789bec4171a6dbc94664e680a3',
        },
        429,
      ),
    );

    const response = await proxyChatCompletions(
      makeNextRequest(),
      {
        model: 'glm-5.1',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
        tools: [{ type: 'web_search_20260209', name: 'web_search' }],
      },
      undefined,
      undefined,
    );

    expect(response.status).toBe(429);
    await expect(response.text()).resolves.toContain('6004');
  });

  it('keeps the body readable when debug tracing snapshots it', async () => {
    await updateDebugSettings({ enabled: true });
    expect(await isDebugEnabled()).toBe(true);

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeJsonResponse(
        {
          code: 6004,
          msg: '您的使用量已超出频率限制',
        },
        429,
      ),
    );

    const response = await proxyChatCompletions(
      makeNextRequest(),
      {
        model: 'glm-5.1',
        messages: [{ role: 'user', content: 'hello' }],
      },
      undefined,
      undefined,
    );

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      error: { detail: expect.stringContaining('6004') },
    });
  });

  it.each([false, true])(
    'reports the upstream rate limit to an Anthropic client (stream: %s)',
    async (stream) => {
      // Claude Code reads `rate_limit_error` to decide whether to back off, so
      // the upstream status has to survive the server-tool bridge on both the
      // non-streaming and the streaming path.
      process.env.SEARXNG_URL = 'https://searx.test';
      resetWebSearchProviders();
      await updateSettings({ CODEBUDDY_WEB_SEARCH_BACKEND: 'searxng' });

      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        makeJsonResponse(
          {
            code: 6004,
            msg: '您的使用量已超出频率限制，将在 2026-09-18 11:35:06 UTC+8 重置',
            requestId: '5d3bd1789bec4171a6dbc94664e680a3',
          },
          429,
        ),
      );

      const response = await handleMessagesRequest(
        new NextRequest('http://localhost/v1/messages', { method: 'POST' }),
        {
          max_tokens: 1024,
          messages: [{ content: 'hello', role: 'user' }],
          model: 'claude-sonnet-4.6',
          stream,
          tools: [{ name: 'web_search', type: 'web_search_20260209' }],
        } as never,
      );

      const body = await response.text();

      if (!stream) {
        expect(response.status).toBe(429);
      }

      expect(body).toContain('rate_limit_error');
      expect(body).toContain('6004');
    },
  );
});
