/**
 * Whether the address the user named is a deployment of this app at all.
 *
 * Asked before the app does anything with it. The console the app renders is
 * its own build, so a wrong address used to mean a stranger's page inside the
 * app's own window — and a page that answers is not the same as a deployment
 * this app can talk to.
 */

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

  if (!response.ok) {
    // A proxy or a captive portal answering for the host: not nothing, but not
    // this app either.
    return { kind: 'foreign' };
  }

  try {
    return isThisService(await response.json())
      ? { kind: 'ready' }
      : { kind: 'foreign' };
  } catch {
    return { kind: 'foreign' };
  }
};
