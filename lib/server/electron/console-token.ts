/**
 * Who a desktop install's console is served to.
 *
 * The console is the app's admin console, and a desktop install serves it with
 * no password: the gateway listens on 127.0.0.1, which was taken to mean "only
 * this computer". Anything on this computer can open 127.0.0.1 in a browser
 * too, though — and a browser pointed at the address gets the whole console,
 * not a page telling it the console is not for it.
 *
 * So the window is what is trusted, rather than the address. The shell makes up
 * a token when it starts, hands the gateway it starts the token through the
 * environment, and puts the same token in a cookie before it loads the console.
 * A request for a console page that does not carry it did not come from the
 * app's own window, and is answered 404.
 *
 * The API is left out of it on purpose: `/v1/*` is what the gateway runs for,
 * and it keeps serving API clients long after the console window was closed.
 */

/** How the shell tells the gateway it started which token to answer to. */
export const DESKTOP_CONSOLE_TOKEN_ENV = 'CODEBUDDY_DESKTOP_CONSOLE_TOKEN';
/** Where the shell puts the token so its own window sends it along. */
export const DESKTOP_CONSOLE_COOKIE = 'codebuddy2api-desktop-console';
/**
 * What a request that is not the window's is told. Short, and no page: there
 * is nothing to explain to a program that was never meant to be here, and a
 * console of the app's is not what a browser should be shown.
 */
export const CONSOLE_DENIED_MESSAGE =
  'This console is only served to the CodeBuddy2API app.';

/** The paths the gateway answers for anyone who asks. */
const OPEN_PATHS = ['/health', '/v1'];

/**
 * Whether a path is one the gateway serves to anything that asks: the API it
 * runs for, and the health check the app waits on.
 */
export const isOpenPath = (pathname: string): boolean =>
  OPEN_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );

/**
 * The token this gateway answers its console for.
 *
 * Null when there is none, which is every install but a desktop one: a
 * deployment someone runs themselves is meant to be reached in a browser, and
 * guards itself with the password it asked for.
 */
export const consoleToken = (
  env: Record<string, string | undefined> = process.env,
): string | null => {
  const token = env[DESKTOP_CONSOLE_TOKEN_ENV]?.trim();

  return token ? token : null;
};

/** As much of a request as the question needs: the cookie it came with. */
export interface ConsoleRequestLike {
  cookies: { get: (name: string) => { value: string } | undefined };
}

/**
 * Whether this request is the app's own window's.
 *
 * True for any request at all when no token was configured — the gate is a
 * desktop install's, and only a desktop install sets one.
 */
export const consoleRequestAllowed = (
  request: ConsoleRequestLike,
  env: Record<string, string | undefined> = process.env,
): boolean => {
  const token = consoleToken(env);

  if (!token) {
    return true;
  }

  return request.cookies.get(DESKTOP_CONSOLE_COOKIE)?.value === token;
};
