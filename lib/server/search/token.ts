/**
 * Supplies a CodeBuddy bearer token to the agent-tool backends.
 *
 * The agent-tool endpoints (`/agenttool/v1/search`, `/agenttool/v1/webfetch`)
 * authenticate with the same credential as the model endpoint, so the gateway
 * already has what they need — but only for the duration of a request. This
 * module bridges that: the proxy sets the credential backing the current
 * request, and the backends read it through an ambient token.
 *
 * `AsyncLocalStorage` is what makes the ambient handoff safe. The registry
 * resolves providers once and caches them, so a provider outlives any single
 * request; passing a token through the provider's constructor would freeze
 * whichever credential happened to be first. Storing it per-request instead
 * means a concurrent request cannot observe another's token, and a rotated
 * credential takes effect on the next call.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { resolveCredentialForRequest } from '../domain/credentials';

export type TokenResolver = () => Promise<string | null>;

/**
 * Resolves the CodeBuddy endpoint the agent-tool paths hang off.
 *
 * Injected into the providers rather than imported from `domain/config`, which
 * already imports back into `search` — a direct import would close a cycle
 * evaluated at module-init time.
 */
export type EndpointResolver = () => Promise<string>;

const tokenStorage = new AsyncLocalStorage<TokenResolver>();

/**
 * Reads the bearer token of the credential backing the current request.
 *
 * Falling back to an unscoped lookup is deliberate: the agent-tool endpoints
 * are also reachable outside a proxy turn, and requiring a request context
 * there would make the backend unusable for no security benefit — the token is
 * only ever sent to the configured CodeBuddy endpoint.
 */
export const resolveCodeBuddyToken: TokenResolver = async () => {
  const ambient = tokenStorage.getStore();

  if (ambient) {
    return ambient();
  }

  const credential = await resolveCredentialForRequest();

  if (!credential) {
    return null;
  }

  const token = String(
    credential.data.bearer_token ?? credential.data.access_token ?? '',
  ).trim();

  return token || null;
};

/**
 * Runs `fn` with `resolveToken` as the token source for any agent-tool call
 * made on that path, including after `await`.
 */
export const withCodeBuddyToken = <T>(
  resolveToken: TokenResolver,
  fn: () => Promise<T>,
): Promise<T> => tokenStorage.run(resolveToken, fn);
