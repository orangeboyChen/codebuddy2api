import { NextRequest } from 'next/server';
import { vi } from 'vitest';

import proxy from '@/proxy';
import { DESKTOP_CONSOLE_TOKEN_ENV } from '@/lib/server/electron/console-token';
import { DESKTOP_DEVICE_TOKEN_ENV } from '@/lib/server/electron/device-token';
import { ADMIN_UPSTREAM_ENV } from '@/lib/server/admin/upstream';

const ORIGIN = 'http://127.0.0.1:8001';

/** A request for a page, with or without the cookie the window carries. */
const pageRequest = (path: string, cookie = ''): NextRequest =>
  new NextRequest(`${ORIGIN}${path}`, cookie ? { headers: { cookie } } : {});

/** Run the proxy as a desktop install whose window carries `token`. */
const withToken = async (
  token: string | null,
  run: () => Promise<Response>,
): Promise<Response> => {
  const before = process.env[DESKTOP_CONSOLE_TOKEN_ENV];

  if (token === null) {
    delete process.env[DESKTOP_CONSOLE_TOKEN_ENV];
  } else {
    process.env[DESKTOP_CONSOLE_TOKEN_ENV] = token;
  }

  try {
    return await run();
  } finally {
    if (before === undefined) {
      delete process.env[DESKTOP_CONSOLE_TOKEN_ENV];
    } else {
      process.env[DESKTOP_CONSOLE_TOKEN_ENV] = before;
    }
  }
};

const through = (response: Response): boolean =>
  response.headers.get('x-middleware-next') === '1';

describe('the console a desktop install serves', () => {
  it("shows the console to the window that carries this run's token", async () => {
    const response = await withToken('token', () =>
      proxy(pageRequest('/', 'codebuddy2api-desktop-console=token')),
    );

    expect(through(response)).toBe(true);
  });

  it.each([
    { path: '/', why: 'the console' },
    { path: '/console', why: 'a console page' },
    { path: '/admin-api/usage?range=today', why: 'the console API' },
  ])('answers 404 for $why asked for without it', async ({ path }) => {
    const response = await withToken('token', () => proxy(pageRequest(path)));

    expect(response.status).toBe(404);
  });

  it('answers the console API in the shape the console speaks', async () => {
    const response = await withToken('token', () =>
      proxy(pageRequest('/admin-api/usage')),
    );

    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({
      error: { message: expect.stringContaining('CodeBuddy2API') },
    });
  });

  it('answers a page with plain text, and no console to read', async () => {
    const response = await withToken('token', () => proxy(pageRequest('/')));

    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(await response.text()).not.toContain('<');
  });

  it('refuses a token from a run that has ended', async () => {
    const response = await withToken('token', () =>
      proxy(pageRequest('/', 'codebuddy2api-desktop-console=stale')),
    );

    expect(response.status).toBe(404);
  });

  it.each([
    { path: '/health', why: 'the health check' },
    { path: '/v1/chat/completions', why: 'the API' },
  ])('still serves $why to anything that asks', async ({ path }) => {
    const response = await withToken('token', () => proxy(pageRequest(path)));

    expect(through(response)).toBe(true);
  });

  // Nothing is asked of an install that made no token up: a deployment someone
  // runs themselves is meant to be opened in a browser.
  it('asks for no token when the shell made none up', async () => {
    const response = await withToken(null, () => proxy(pageRequest('/')));

    expect(through(response)).toBe(true);
  });

  it('sends the token the user approved this app with to the deployment', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}'));
    const before = {
      device: process.env[DESKTOP_DEVICE_TOKEN_ENV],
      upstream: process.env[ADMIN_UPSTREAM_ENV],
    };

    process.env[DESKTOP_DEVICE_TOKEN_ENV] = 'device-token';
    process.env[ADMIN_UPSTREAM_ENV] = 'https://codebuddy.example.com';
    vi.stubGlobal('fetch', fetchImpl);

    try {
      await withToken('token', () =>
        proxy(
          pageRequest(
            '/admin-api/usage',
            'codebuddy2api-desktop-console=token',
          ),
        ),
      );
    } finally {
      vi.unstubAllGlobals();

      for (const [name, value] of [
        [DESKTOP_DEVICE_TOKEN_ENV, before.device],
        [ADMIN_UPSTREAM_ENV, before.upstream],
      ] as const) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    }

    const headers = new Headers(
      (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1]
        .headers as HeadersInit,
    );

    expect(headers.get('authorization')).toBe('Bearer device-token');
  });
});
