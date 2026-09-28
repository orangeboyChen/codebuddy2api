import {
  CONSOLE_DENIED_MESSAGE,
  DESKTOP_CONSOLE_COOKIE,
  DESKTOP_CONSOLE_TOKEN_ENV,
  consoleRequestAllowed,
  consoleToken,
  isOpenPath,
} from '@/lib/server/electron/console-token';

/** A request as the gate sees it: the one cookie it asks about. */
const requestWith = (cookies: Record<string, string> = {}) => ({
  cookies: {
    get: (name: string) =>
      name in cookies ? { value: cookies[name] } : undefined,
  },
});

describe('isOpenPath', () => {
  it.each([
    { path: '/health', why: 'the health check' },
    { path: '/v1', why: 'the API itself' },
    { path: '/v1/chat/completions', why: 'one endpoint of the API' },
  ])('answers $why for anyone', ({ path }) => {
    expect(isOpenPath(path)).toBe(true);
  });

  it.each([
    { path: '/', why: 'the console' },
    { path: '/console', why: 'a console page' },
    { path: '/admin-api/usage', why: 'the console API' },
    { path: '/v1something', why: 'a path that only starts like it' },
    { path: '', why: 'nothing' },
  ])('guards $why', ({ path }) => {
    expect(isOpenPath(path)).toBe(false);
  });
});

describe('consoleToken', () => {
  it('reads the token the shell handed this gateway', () => {
    expect(consoleToken({ [DESKTOP_CONSOLE_TOKEN_ENV]: 'abc' })).toBe('abc');
  });

  it.each([
    { env: {}, why: 'no token set' },
    { env: { [DESKTOP_CONSOLE_TOKEN_ENV]: '' }, why: 'an empty one' },
    { env: { [DESKTOP_CONSOLE_TOKEN_ENV]: '   ' }, why: 'only whitespace' },
  ])('has none for $why', ({ env }) => {
    expect(consoleToken(env)).toBeNull();
  });
});

describe('consoleRequestAllowed', () => {
  it("lets the request carrying this run's token through", () => {
    expect(
      consoleRequestAllowed(requestWith({ [DESKTOP_CONSOLE_COOKIE]: 'abc' }), {
        [DESKTOP_CONSOLE_TOKEN_ENV]: 'abc',
      }),
    ).toBe(true);
  });

  const refused: Array<{ cookies: Record<string, string>; why: string }> = [
    {
      cookies: {},
      why: 'a request with no cookie at all',
    },
    {
      cookies: { [DESKTOP_CONSOLE_COOKIE]: 'from-another-run' },
      why: 'a token from a run that has ended',
    },
    {
      cookies: { [DESKTOP_CONSOLE_COOKIE]: '' },
      why: 'an empty cookie',
    },
    {
      cookies: { 'codebuddy2api-locale': 'abc' },
      why: 'a cookie that is not the token',
    },
  ];

  it.each(refused)('refuses $why', ({ cookies }) => {
    expect(
      consoleRequestAllowed(requestWith(cookies), {
        [DESKTOP_CONSOLE_TOKEN_ENV]: 'abc',
      }),
    ).toBe(false);
  });

  // Nothing to answer to, so nothing to refuse: a deployment someone runs
  // themselves is meant to be opened in a browser, and guards itself.
  it('lets everything through when no token was configured', () => {
    expect(consoleRequestAllowed(requestWith({}))).toBe(true);
    expect(consoleRequestAllowed(requestWith({}), {})).toBe(true);
  });

  it('says why a browser was refused, without a page to show it', () => {
    expect(CONSOLE_DENIED_MESSAGE).toContain('CodeBuddy2API');
  });
});
