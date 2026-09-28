import { NextResponse, type NextRequest } from 'next/server';

import {
  CONSOLE_DENIED_MESSAGE,
  consoleRequestAllowed,
  isOpenPath,
} from '@/lib/server/electron/console-token';
import { deviceToken } from '@/lib/server/electron/device-token';
import {
  forwardToUpstream,
  isProxiedPath,
  resolveAdminUpstream,
} from '@/lib/server/admin/upstream';

/**
 * What a request that is not the desktop app's own window gets: 404, in the
 * shape the caller speaks — a payload for the API the console talks to, plain
 * text for a page nobody should have been shown.
 */
const notTheWindow = (request: NextRequest): Response =>
  request.nextUrl.pathname.startsWith('/admin-api')
    ? NextResponse.json(
        { error: { message: CONSOLE_DENIED_MESSAGE } },
        { status: 404 },
      )
    : new NextResponse(CONSOLE_DENIED_MESSAGE, {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        status: 404,
      });

/**
 * The desktop app's console is this build; only its data comes from the
 * deployment the user named. See `lib/server/admin/upstream`.
 *
 * Left out of the way entirely when no deployment is configured, which is every
 * other install: the matcher still runs, but answers `next()` at once.
 */
const proxy = async (request: NextRequest): Promise<Response> => {
  // A desktop install's console belongs to the window the app opened: a browser
  // on the same machine — or a script on it — is answered 404 rather than shown
  // a console it was never meant to have. The API and the health check are the
  // gateway's business with this machine, which goes on with the window closed.
  if (
    !isOpenPath(request.nextUrl.pathname) &&
    !consoleRequestAllowed(request)
  ) {
    return notTheWindow(request);
  }

  const upstream = resolveAdminUpstream();

  if (!upstream || !isProxiedPath(request.nextUrl.pathname)) {
    return NextResponse.next();
  }

  return forwardToUpstream({
    // What the deployment handed this app when the user approved it there.
    deviceToken: deviceToken(),
    localOrigin: request.nextUrl.origin,
    request: request as unknown as Request,
    upstream,
  });
};

export default proxy;

export const config = {
  // Everything but the health check, the build's own assets, and anything with a
  // file extension: the pages are answered here even with a deployment named,
  // and which of them the request is decides whether it is forwarded.
  matcher: ['/((?!health|_next|.*\\..*).*)'],
};
