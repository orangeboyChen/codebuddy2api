import {
  adminCookieHeader,
  fetchTodayUsage,
  usageFromAnalytics,
} from '@/lib/server/electron/usage';

const analytics = (rows: Array<Record<string, unknown>>): unknown => ({
  range: 'today',
  tableRows: rows,
});

describe('usageFromAnalytics', () => {
  it('adds the rows up', () => {
    expect(
      usageFromAnalytics(
        analytics([
          { inputTokens: 120, outputTokens: 30 },
          { inputTokens: 400, outputTokens: 100 },
        ]),
      ),
    ).toEqual({ input: 520, output: 130 });
  });

  it('counts no rows as zero rather than as unknown', () => {
    expect(usageFromAnalytics(analytics([]))).toEqual({ input: 0, output: 0 });
  });

  it.each([
    { payload: null, why: 'null' },
    { payload: 'nope', why: 'not an object' },
    { payload: { range: 'today' }, why: 'no rows' },
    { payload: { tableRows: 'rows' }, why: 'rows that are not an array' },
    { payload: [], why: 'an array' },
  ])('reports nothing usable for $why', ({ payload }) => {
    expect(usageFromAnalytics(payload)).toBeNull();
  });

  it.each([
    { value: undefined, why: 'a missing count' },
    { value: '12', why: 'a string count' },
    { value: Number.NaN, why: 'NaN' },
    { value: Number.POSITIVE_INFINITY, why: 'infinity' },
    { value: -5, why: 'a negative count' },
  ])('ignores $why', ({ value }) => {
    expect(
      usageFromAnalytics(
        analytics([{ inputTokens: value, outputTokens: value }]),
      ),
    ).toEqual({ input: 0, output: 0 });
  });

  it('rounds a fractional count down', () => {
    expect(
      usageFromAnalytics(analytics([{ inputTokens: 10.9, outputTokens: 1.5 }])),
    ).toEqual({ input: 10, output: 1 });
  });

  it.each([
    { row: null, why: 'null' },
    { row: 7, why: 'not an object' },
  ])('skips a row that is $why', ({ row }) => {
    expect(
      usageFromAnalytics(
        analytics([
          row as unknown as Record<string, unknown>,
          { inputTokens: 5, outputTokens: 5 },
        ]),
      ),
    ).toEqual({
      input: 5,
      output: 5,
    });
  });
});

describe('fetchTodayUsage', () => {
  const jsonResponse = (body: unknown, status = 200): Response =>
    Response.json(body, { status });

  it('asks for today and sums what comes back', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(analytics([{ inputTokens: 900, outputTokens: 100 }])),
    );

    vi.stubGlobal('fetch', fetchMock);

    expect(
      await fetchTodayUsage({
        baseUrl: 'https://api.example.com',
        cookie: 'codebuddy_admin_session=abc',
      }),
    ).toEqual({ input: 900, output: 100 });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/admin-api/usage?range=today',
      {
        headers: { cookie: 'codebuddy_admin_session=abc' },
        signal: expect.anything(),
      },
    );
  });

  it('sends no cookie header when it has none', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(analytics([])));

    vi.stubGlobal('fetch', fetchMock);

    await fetchTodayUsage({ baseUrl: 'http://127.0.0.1:8001' });

    expect(fetchMock).toHaveBeenCalledWith(expect.any(String), {
      headers: {},
      signal: expect.anything(),
    });
  });

  it.each([
    { status: 401, why: 'a sign-in the shell has no cookie for' },
    { status: 500, why: 'a backend error' },
  ])('reports nothing on $why', async ({ status }) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({}, status)),
    );

    expect(
      await fetchTodayUsage({ baseUrl: 'https://api.example.com' }),
    ).toBeNull();
  });

  it('reports nothing when the backend is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );

    expect(
      await fetchTodayUsage({ baseUrl: 'http://127.0.0.1:8001' }),
    ).toBeNull();
  });

  it('reports nothing on a body that is not usage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ error: 'nope' })),
    );

    expect(
      await fetchTodayUsage({ baseUrl: 'https://api.example.com' }),
    ).toBeNull();
  });
});

describe('adminCookieHeader', () => {
  it('sends the session cookie and the desktop console token', () => {
    expect(
      adminCookieHeader([
        { name: 'codebuddy_admin_session', value: 'abc' },
        { name: 'codebuddy2api-desktop-console', value: 'def' },
        { name: 'codebuddy2api-locale', value: 'zh-CN' },
      ]),
    ).toBe('codebuddy_admin_session=abc; codebuddy2api-desktop-console=def');
  });

  it.each([
    { cookies: [], why: 'no cookies' },
    {
      cookies: [
        { name: 'codebuddy_admin_session', value: '' },
        { name: 'codebuddy2api-desktop-console', value: '' },
      ],
      why: 'cookies with nothing in them',
    },
  ])('sends nothing for $why', ({ cookies }) => {
    expect(adminCookieHeader(cookies)).toBe('');
  });
});
