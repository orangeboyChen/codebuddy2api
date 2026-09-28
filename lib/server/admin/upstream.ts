/**
 * Serving this console, reading someone else's data.
 *
 * The desktop app always renders its own build of the console — the one bundled
 * into the app — and when the user points it at a deployment they already run,
 * only the data comes from there: everything under `/admin-api` and `/v1` is
 * forwarded, and every page and asset is answered here.
 *
 * That is the whole point: no page the app did not ship is ever rendered in its
 * window, and the console still comes up with the network down — empty, and
 * saying why, rather than not at all.
 *
 * Nothing here imports storage or crypto: the middleware that forwards the
 * requests runs in the edge runtime, where those do not exist.
 */

/** The deployment whose data this console shows. An origin, no path. */
export const ADMIN_UPSTREAM_ENV = 'CODEBUDDY_ADMIN_UPSTREAM';

/**
 * How long the deployment gets to answer. Only the wait for the head: once a
 * response has started, a stream is left to finish in its own time — a chat
 * completion is allowed to take minutes.
 */
const UPSTREAM_HEADERS_TIMEOUT_MS = 15_000;

/** Answered here even with a deployment configured: the app's own settings. */
const LOCAL_ONLY_PATHS = ['/admin-api/desktop'];

/** Copied from the request, and nothing else: see `forwardToUpstream`. */
const SKIPPED_REQUEST_HEADERS = [
  'host',
  'content-length',
  'content-encoding',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
];

/** Replaced by the runtime downstream: the body it receives is already decoded. */
const SKIPPED_RESPONSE_HEADERS = [
  'content-length',
  'content-encoding',
  'connection',
  'keep-alive',
  'transfer-encoding',
];

/** Kept from a cookie the deployment set; the rest describes the wrong site. */
const KEPT_COOKIE_ATTRIBUTES = [
  'expires',
  'max-age',
  'path',
  'samesite',
  'httponly',
];

export type AdminSessionSummary = Awaited<
  ReturnType<typeof import('./session').getAdminSessionSummary>
>;

/** The deployment, or null when this console serves its own data. */
export const resolveAdminUpstream = (
  env: Record<string, string | undefined> = process.env,
): string | null => {
  const value = env[ADMIN_UPSTREAM_ENV]?.trim();

  if (!value) {
    return null;
  }

  try {
    const parsed = new URL(value);

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }

    // The origin alone: a path on the setting would have to be prefixed onto
    // every forwarded path to mean anything.
    return parsed.origin;
  } catch {
    return null;
  }
};

export const adminUpstreamEnabled = (
  env: Record<string, string | undefined> = process.env,
): boolean => resolveAdminUpstream(env) !== null;

/**
 * Whether a path goes to the deployment.
 *
 * The app's own settings are answered here even then: which port this gateway
 * runs on is a fact about this machine, not about the deployment.
 */
export const isProxiedPath = (pathname: string): boolean => {
  const path = pathname.trim();

  if (
    LOCAL_ONLY_PATHS.some(
      (local) => path === local || path.startsWith(`${local}/`),
    )
  ) {
    return false;
  }

  return (
    path === '/admin-api' ||
    path.startsWith('/admin-api/') ||
    path === '/v1' ||
    path.startsWith('/v1/')
  );
};

const rewriteCookie = (cookie: string): string => {
  const [pair, ...attributes] = cookie.split(';').map((part) => part.trim());
  const kept = attributes.filter((attribute) => {
    const name = attribute.split('=')[0].toLowerCase();

    // The browser has to bind the cookie to this origin, not to the host it
    // was issued for, and this console is plain http on loopback — a `secure`
    // cookie would never be sent back.
    return KEPT_COOKIE_ATTRIBUTES.includes(name);
  });

  return [pair, ...kept].join('; ');
};

const setCookiesOf = (response: Response): string[] => {
  const headers = response.headers as Headers & {
    getSetCookie?: () => string[];
  };

  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie();
  }

  const single = response.headers.get('set-cookie');

  return single ? [single] : [];
};

/**
 * A redirect the deployment answered with points at the deployment. Sent on
 * unchanged it would take the window out of the app to a page this console did
 * not render — the one thing this forwarding exists to avoid.
 */
const rewriteLocation = (location: string, upstream: string, local: string) =>
  location.startsWith(upstream)
    ? `${local}${location.slice(upstream.length)}`
    : location;

const copyResponseHeaders = (
  source: Response,
  upstream: string,
  localOrigin: string,
): Headers => {
  const headers = new Headers();

  source.headers.forEach((value, name) => {
    if (SKIPPED_RESPONSE_HEADERS.includes(name) || name === 'set-cookie') {
      return;
    }

    headers.set(
      name,
      name === 'location'
        ? rewriteLocation(value, upstream, localOrigin)
        : value,
    );
  });

  for (const cookie of setCookiesOf(source)) {
    headers.append('set-cookie', rewriteCookie(cookie));
  }

  return headers;
};

export interface ForwardOptions {
  /**
   * The token this app was handed by the deployment, to be sent along with
   * everything forwarded to it. It is the desktop's half of the device
   * authorization grant: the user approved this app on the deployment's own
   * page, where a passkey works, and this is how the window is signed in
   * without a password ever being typed into it.
   */
  deviceToken?: string | null;
  request: Request;
  /** The origin this console is served from, for redirects it has to keep. */
  localOrigin: string;
  timeoutMs?: number;
  upstream: string;
}

/**
 * The deployment's answer to a request the console made.
 *
 * A deployment that cannot be reached is answered here with a 502 in the shape
 * the console already understands, rather than with an error the page would
 * have to tell apart from its own.
 */
export const forwardToUpstream = async ({
  deviceToken = null,
  localOrigin,
  request,
  timeoutMs = UPSTREAM_HEADERS_TIMEOUT_MS,
  upstream,
}: ForwardOptions): Promise<Response> => {
  const url = `${upstream}${new URL(request.url).pathname}${
    new URL(request.url).search
  }`;
  const headers = new Headers();

  request.headers.forEach((value, name) => {
    if (!SKIPPED_REQUEST_HEADERS.includes(name)) {
      headers.set(name, value);
    }
  });

  // Only when the window sent none of its own: a session cookie the user signed
  // in with in this window is the stronger claim, and both at once would ask the
  // deployment to decide between them.
  if (deviceToken?.trim() && !headers.has('authorization')) {
    headers.set('authorization', `Bearer ${deviceToken.trim()}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(url, {
      body:
        request.method === 'GET' || request.method === 'HEAD'
          ? undefined
          : await request.arrayBuffer(),
      headers,
      method: request.method,
      // Kept: a redirect would take the window to a page this app did not ship.
      redirect: 'manual',
      signal: controller.signal,
    });

    return new Response(response.body, {
      headers: copyResponseHeaders(response, upstream, localOrigin),
      status: response.status,
      statusText: response.statusText,
    });
  } catch {
    return Response.json(
      {
        error: {
          message: `Could not reach ${upstream}. Check the connection and the address in the menu bar.`,
        },
      },
      { status: 502 },
    );
  } finally {
    clearTimeout(timer);
  }
};

/**
 * What a request this console makes of the deployment carries.
 *
 * The window's own cookie, and — when the user approved this app in a browser —
 * the token that came back. Both, because a page rendered here is not a request
 * the proxy forwards: nothing else would attach the token to it, and a console
 * rendered signed out while the menu bar says signed in is the grant not
 * working.
 */
const upstreamHeaders = ({
  cookie,
  deviceToken,
}: {
  cookie?: string;
  deviceToken?: string | null;
}): Record<string, string> => {
  const headers: Record<string, string> = {};

  if (cookie?.trim()) {
    headers.cookie = cookie;
  }

  if (deviceToken?.trim()) {
    headers.authorization = `Bearer ${deviceToken.trim()}`;
  }

  return headers;
};

/**
 * The accounts the deployment can see, and what they are worth.
 *
 * The one page that reads its data on the server rather than asking
 * `/admin-api` from the browser: it is built from the credentials the backend
 * owns, and a console showing a deployment's data reads those from the
 * deployment — its own storage has none of them.
 *
 * Null when the deployment could not answer, so the page comes up empty rather
 * than claiming there are no accounts at all.
 */
export const fetchUpstreamAccountStatus = async ({
  cookie = '',
  deviceToken = null,
  timeoutMs = UPSTREAM_HEADERS_TIMEOUT_MS,
  upstream,
}: {
  cookie?: string;
  deviceToken?: string | null;
  timeoutMs?: number;
  upstream: string;
}): Promise<{ credentials: unknown[]; statuses: unknown[] } | null> => {
  try {
    const response = await fetch(`${upstream}/admin-api/account-status`, {
      headers: upstreamHeaders({ cookie, deviceToken }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as {
      credentials?: unknown;
      statuses?: unknown;
    };

    return {
      credentials: Array.isArray(payload.credentials)
        ? payload.credentials
        : [],
      statuses: Array.isArray(payload.statuses) ? payload.statuses : [],
    };
  } catch {
    return null;
  }
};

/**
 * What the console is told when the deployment could not be asked.
 *
 * A sign-in form rather than a setup form: which one the deployment wants is
 * exactly what could not be found out, and neither can be set up from here.
 */
export const unreachableSessionSummary = (): AdminSessionSummary => ({
  accountConfigured: true,
  authEnabled: true,
  authenticated: false,
  passkeyCount: 0,
  passwordConfigured: true,
  usagePreferences: null,
  username: 'admin',
});

/**
 * Whether the deployment wants a sign-in, and whether it has one.
 *
 * Asked of the deployment rather than answered here: it is the one that owns
 * the password, and a desktop install of this app has none of its own. Null
 * when it could not be asked — an unreachable deployment leaves the console
 * up and unexplained rather than claiming there is nothing to sign in to.
 */
export const fetchUpstreamSessionSummary = async ({
  cookie = '',
  deviceToken = null,
  timeoutMs = UPSTREAM_HEADERS_TIMEOUT_MS,
  upstream,
}: {
  cookie?: string;
  deviceToken?: string | null;
  timeoutMs?: number;
  upstream: string;
}): Promise<AdminSessionSummary | null> => {
  try {
    const response = await fetch(`${upstream}/admin-api/auth/session`, {
      headers: upstreamHeaders({ cookie, deviceToken }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      return null;
    }

    const session = ((await response.json()) as { session?: unknown }).session;

    return session && typeof session === 'object' && 'authenticated' in session
      ? (session as AdminSessionSummary)
      : null;
  } catch {
    return null;
  }
};
