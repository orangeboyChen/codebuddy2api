/**
 * Whether the deployment would answer its console to this app.
 *
 * Asked of the deployment every time, and not only when no token is held, which
 * is the whole point of asking: a token is good for thirty days on the
 * deployment's side and is kept here without one, so an expired one is still a
 * token — sent with everything the console asks for, and answered with the
 * deployment's own login page in this app's window, which is the one thing the
 * device flow exists to keep out of it.
 *
 * `unknown` is a deployment that did not answer, or not with a session: not a
 * sign-in that is missing, and not one to claim either. The console is opened
 * and says whatever it has to say about it.
 */
export type DeploymentSignIn =
  /** Signed in — or a console with no account to sign in to at all. */
  | { kind: 'ready' }
  /** It answered, and it wants this app signed in before its console opens. */
  | { kind: 'needsSignIn' }
  /** It did not answer, or not with anything to read a session off. */
  | { kind: 'unknown' };

export interface DeploymentSignInOptions {
  /** The token the deployment handed this app, when the user approved one. */
  deviceToken?: string | null;
  url: string;
}

export const deploymentSignIn = async ({
  deviceToken = null,
  url,
}: DeploymentSignInOptions): Promise<DeploymentSignIn> => {
  const session = await fetchUpstreamSessionSummary({
    deviceToken,
    upstream: url,
  });

  if (!session) {
    return { kind: 'unknown' };
  }

  return session.accountConfigured && !session.authenticated
    ? { kind: 'needsSignIn' }
    : { kind: 'ready' };
};

/**
 * Whether the address the user named is a deployment of this app at all.
 *
 * Asked before the app does anything with it. The console the app renders is
 * its own build, so a wrong address used to mean a stranger's page inside the
 * app's own window — and a page that answers is not the same as a deployment
 * this app can talk to.
 */

import { fetchUpstreamSessionSummary } from '../admin/upstream';

/**
 * How long the deployment gets to answer. Long enough for a cold deployment
 * waking up, short enough that a mistyped host does not look like a hang.
 */
const PROBE_TIMEOUT_MS = 10_000;

/** What `/health` names itself, on every build of this app. */
const SERVICE_NAME = 'codebuddy2api';

export type DeploymentProbe =
  /** A deployment of this app, answering. */
  | { kind: 'ready' }
  /** Nothing answered: offline, a wrong host, a firewall. */
  | { kind: 'unreachable' }
  /** Something answered, and it is not this app. */
  | { kind: 'foreign' };

export interface ProbeOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  url: string;
}

const isThisService = (payload: unknown): boolean =>
  Boolean(
    payload &&
    typeof payload === 'object' &&
    (payload as { service?: unknown }).service === SERVICE_NAME,
  );

export const probeDeployment = async ({
  fetchImpl = fetch,
  timeoutMs = PROBE_TIMEOUT_MS,
  url,
}: ProbeOptions): Promise<DeploymentProbe> => {
  let response: Response;

  try {
    response = await fetchImpl(new URL('/health', url).toString(), {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { kind: 'unreachable' };
  }

  // Read before trusting the status: a deployment answers 503 from `/health`
  // while its storage is unhealthy, and it is still this app — it says so in the
  // payload. Rejecting it first would tell the user the address is not a
  // deployment, which is the one thing it certainly is.
  try {
    return isThisService(await response.json())
      ? { kind: 'ready' }
      : { kind: 'foreign' };
  } catch {
    // A proxy or a captive portal answering for the host: not nothing, but not
    // this app either — and it never names itself.
    return { kind: 'foreign' };
  }
};
