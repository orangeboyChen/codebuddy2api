import {
  ADMIN_UPSTREAM_ENV,
  adminUpstreamEnabled,
  fetchUpstreamSessionSummary,
  forwardToUpstream,
  isProxiedPath,
  resolveAdminUpstream,
  unreachableSessionSummary,
} from '@/lib/server/admin/upstream';

const LOCAL_ORIGIN = 'http://127.0.0.1:8001';
const UPSTREAM = 'https://codebuddy.example.com';

const request = (url: string, init: RequestInit = {}): Request =>
  new Request(url, init);

describe('resolveAdminUpstream', () => {
  it('has no deployment when none is named', () => {
    expect(resolveAdminUpstream({})).toBeNull();
  });

  it('has no deployment for a setting that is only whitespace', () => {
    expect(resolveAdminUpstream({ [ADMIN_UPSTREAM_ENV]: '   ' })).toBeNull();
  });

  it('keeps the origin, and drops a path that would have meant nothing', () => {
    expect(
      resolveAdminUpstream({
        [ADMIN_UPSTREAM_ENV]: 'https://codebuddy.example.com/console/',
      }),
    ).toBe('https://codebuddy.example.com');
  });

  it.each([
    'ftp://codebuddy.example.com',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'codebuddy.example.com',
    '',
  ])('refuses %s', (value) => {
    expect(resolveAdminUpstream({ [ADMIN_UPSTREAM_ENV]: value })).toBeNull();
  });

  it('reads the environment it is given, not the process one', () => {
    expect(
      adminUpstreamEnabled({ [ADMIN_UPSTREAM_ENV]: 'http://10.0.0.5:9000' }),
    ).toBe(true);
    expect(adminUpstreamEnabled({})).toBe(false);
  });
});

describe('isProxiedPath', () => {
  it.each([
    '/admin-api',
    '/admin-api/usage/today',
    '/v1',
    '/v1/chat/completions',
  ])('sends %s to the deployment', (path) => {
    expect(isProxiedPath(path)).toBe(true);
  });

  it.each([
    '/',
    '/dashboard',
    '/login',
    '/health',
    '/_next/static/chunk.js',
    // Answered here even with a deployment: the port this gateway runs on is a
    // fact about this machine.
    '/admin-api/desktop',
    '/admin-api/desktop/settings',
  ])('answers %s itself', (path) => {
    expect(isProxiedPath(path)).toBe(false);
  });
});

describe('forwardToUpstream', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const respond = (
    init: {
      body?: BodyInit | null;
      headers?: HeadersInit;
      status?: number;
    } = {},
  ): Response =>
    new Response(init.body ?? null, {
      headers: init.headers,
      status: init.status ?? 200,
    });

  it('asks the deployment for the same path and query', async () => {
    const fetchImpl = vi.fn(async () => respond());
    vi.stubGlobal('fetch', fetchImpl);

    await forwardToUpstream({
      localOrigin: LOCAL_ORIGIN,
      request: request(`${LOCAL_ORIGIN}/admin-api/usage/today?tz=8`),
      upstream: UPSTREAM,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      `${UPSTREAM}/admin-api/usage/today?tz=8`,
      expect.objectContaining({ method: 'GET', redirect: 'manual' }),
    );
  });

  it('passes the method, the body and the headers on', async () => {
    const fetchImpl = vi.fn(async () => respond());
    vi.stubGlobal('fetch', fetchImpl);

    await forwardToUpstream({
      localOrigin: LOCAL_ORIGIN,
      request: request(`${LOCAL_ORIGIN}/admin-api/keys`, {
        body: '{"name":"a"}',
        headers: {
          authorization: 'Bearer x',
          'content-type': 'application/json',
        },
        method: 'POST',
      }),
      upstream: UPSTREAM,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      `${UPSTREAM}/admin-api/keys`,
      expect.objectContaining({
        body: new Uint8Array(new TextEncoder().encode('{"name":"a"}')).buffer,
        method: 'POST',
      }),
    );
  });

  it('sends no body for a GET', async () => {
    const fetchImpl = vi.fn(async () => respond());
    vi.stubGlobal('fetch', fetchImpl);

    await forwardToUpstream({
      localOrigin: LOCAL_ORIGIN,
      request: request(`${LOCAL_ORIGIN}/admin-api/usage/today`),
      upstream: UPSTREAM,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ body: undefined }),
    );
  });

  it('drops the headers that describe the hop it made', async () => {
    const fetchImpl = vi.fn(async () => respond());
    vi.stubGlobal('fetch', fetchImpl);

    await forwardToUpstream({
      localOrigin: LOCAL_ORIGIN,
      request: request(`${LOCAL_ORIGIN}/v1/models`, {
        headers: {
          connection: 'keep-alive',
          cookie: 'codebuddy_admin_session=abc',
          host: '127.0.0.1:8001',
        },
      }),
      upstream: UPSTREAM,
    });

    const headers = new Headers(
      (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1]
        .headers as HeadersInit,
    );

    expect(headers.get('cookie')).toBe('codebuddy_admin_session=abc');
    expect(headers.get('host')).toBeNull();
    expect(headers.get('connection')).toBeNull();
  });

  it('streams the answer back rather than waiting for it', async () => {
    const chunk = new TextEncoder().encode('data: {"a":1}\n\n');
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(chunk);
              controller.close();
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    vi.stubGlobal('fetch', fetchImpl);

    const response = await forwardToUpstream({
      localOrigin: LOCAL_ORIGIN,
      request: request(`${LOCAL_ORIGIN}/admin-api/chat/completions`, {
        method: 'POST',
      }),
      upstream: UPSTREAM,
    });

    await expect(response.text()).resolves.toBe('data: {"a":1}\n\n');
    expect(response.headers.get('content-type')).toBe('text/event-stream');
  });

  it('answers 502 in the shape the console knows when the deployment is gone', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('fetch failed');
      }),
    );

    const response = await forwardToUpstream({
      localOrigin: LOCAL_ORIGIN,
      request: request(`${LOCAL_ORIGIN}/admin-api/usage/today`),
      upstream: UPSTREAM,
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: { message: expect.stringContaining(UPSTREAM) },
    });
  });

  it('binds a session cookie to this console, not to the deployment', async () => {
    const headers = new Headers();
    headers.append(
      'set-cookie',
      'codebuddy_admin_session=abc; Domain=codebuddy.example.com; Path=/; HttpOnly; Secure; SameSite=Lax',
    );
    headers.append('set-cookie', 'other=1; Max-Age=60; Domain=example.com');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond({ headers })),
    );

    const response = await forwardToUpstream({
      localOrigin: LOCAL_ORIGIN,
      request: request(`${LOCAL_ORIGIN}/admin-api/auth/login`, {
        method: 'POST',
      }),
      upstream: UPSTREAM,
    });

    expect(response.headers.getSetCookie()).toEqual([
      'codebuddy_admin_session=abc; Path=/; HttpOnly; SameSite=Lax',
      'other=1; Max-Age=60',
    ]);
  });

  it('rewrites the one cookie a runtime hands over as a single header', async () => {
    // A runtime whose `Headers` has no `getSetCookie`: the rewrite then has to
    // work from the header alone.
    const headers = {
      forEach: (visit: (value: string, name: string) => void) => {
        visit('application/json', 'content-type');
      },
      get: (name: string) =>
        name === 'set-cookie'
          ? 'codebuddy_admin_session=abc; Domain=codebuddy.example.com; Secure'
          : null,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ body: null, headers, status: 200 })),
    );

    const response = await forwardToUpstream({
      localOrigin: LOCAL_ORIGIN,
      request: request(`${LOCAL_ORIGIN}/admin-api/auth/login`, {
        method: 'POST',
      }),
      upstream: UPSTREAM,
    });

    expect(response.headers.getSetCookie()).toEqual([
      'codebuddy_admin_session=abc',
    ]);
  });

  it('rewrites a redirect back into this console', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        respond({
          headers: { location: `${UPSTREAM}/login` },
          status: 302,
        }),
      ),
    );

    const response = await forwardToUpstream({
      localOrigin: LOCAL_ORIGIN,
      request: request(`${LOCAL_ORIGIN}/`),
      upstream: UPSTREAM,
    });

    expect(response.headers.get('location')).toBe(`${LOCAL_ORIGIN}/login`);
  });

  it('leaves a redirect to somewhere else alone: it is not followed either way', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        respond({
          headers: { location: 'https://evil.example/login' },
          status: 302,
        }),
      ),
    );

    const response = await forwardToUpstream({
      localOrigin: LOCAL_ORIGIN,
      request: request(`${LOCAL_ORIGIN}/`),
      upstream: UPSTREAM,
    });

    expect(response.headers.get('location')).toBe('https://evil.example/login');
  });

  it('gives up on a deployment that does not answer in time', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => {
              reject(new Error('aborted'));
            });
          }),
      ),
    );

    const response = await forwardToUpstream({
      localOrigin: LOCAL_ORIGIN,
      request: request(`${LOCAL_ORIGIN}/admin-api/usage/today`),
      timeoutMs: 5,
      upstream: UPSTREAM,
    });

    expect(response.status).toBe(502);
  });
});

describe('fetchUpstreamSessionSummary', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const respond = (payload: unknown, ok = true): typeof fetch =>
    vi.fn(async () => ({
      json: async () => payload,
      ok,
    })) as unknown as typeof fetch;

  it('asks the deployment whose password applies', async () => {
    const fetchImpl = respond({ session: { authenticated: true } });
    vi.stubGlobal('fetch', fetchImpl);

    await expect(
      fetchUpstreamSessionSummary({
        cookie: 'session=abc',
        upstream: UPSTREAM,
      }),
    ).resolves.toEqual({ authenticated: true });

    expect(fetchImpl).toHaveBeenCalledWith(
      `${UPSTREAM}/admin-api/auth/session`,
      expect.objectContaining({ headers: { cookie: 'session=abc' } }),
    );
  });

  it('sends no cookie header when there is no session yet', async () => {
    const fetchImpl = respond({ session: { authenticated: false } });
    vi.stubGlobal('fetch', fetchImpl);

    await fetchUpstreamSessionSummary({ upstream: UPSTREAM });

    expect(fetchImpl).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: {} }),
    );
  });

  it.each([
    { payload: {}, why: 'an answer with no session' },
    { payload: { session: null }, why: 'a null session' },
    {
      payload: { session: { accountConfigured: true } },
      why: 'a session with no answer about itself',
    },
  ])('has nothing to say for $why', async ({ payload }) => {
    vi.stubGlobal('fetch', respond(payload));

    await expect(
      fetchUpstreamSessionSummary({ upstream: UPSTREAM }),
    ).resolves.toBeNull();
  });

  it('has nothing to say when the deployment refuses the question', async () => {
    vi.stubGlobal(
      'fetch',
      respond({ session: { authenticated: true } }, false),
    );

    await expect(
      fetchUpstreamSessionSummary({ upstream: UPSTREAM }),
    ).resolves.toBeNull();
  });

  it('has nothing to say when the deployment cannot be asked', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('fetch failed');
      }),
    );

    await expect(
      fetchUpstreamSessionSummary({ upstream: UPSTREAM }),
    ).resolves.toBeNull();
  });

  it('falls back to a sign-in form, which is the one thing it can still offer', () => {
    expect(unreachableSessionSummary()).toEqual(
      expect.objectContaining({ authenticated: false }),
    );
  });
});
