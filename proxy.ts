import { NextResponse, type NextRequest } from 'next/server';

import {
  forwardToUpstream,
  isProxiedPath,
  resolveAdminUpstream,
} from '@/lib/server/admin/upstream';

/**
 * The desktop app's console is this build; only its data comes from the
 * deployment the user named. See `lib/server/admin/upstream`.
 *
 * Left out of the way entirely when no deployment is configured, which is every
 * other install: the matcher still runs, but answers `next()` at once.
 */
const proxy = async (request: NextRequest): Promise<Response> => {
  const upstream = resolveAdminUpstream();

  if (!upstream || !isProxiedPath(request.nextUrl.pathname)) {
    return NextResponse.next();
  }

  return forwardToUpstream({
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
