/**
 * Whether the SearXNG search backend is configured.
 *
 * Split into its own leaf module because `domain/config` needs this answer
 * synchronously while building the settings labels, and importing it from
 * `search` (the registry) would close an import cycle: the registry's CodeBuddy
 * backends need the configured endpoint, which lives in `domain/config`.
 *
 * Only SearXNG is covered. The CodeBuddy backend needs no deployment-level
 * configuration beyond a credential, so there is nothing for a synchronous
 * check to confirm.
 */

import { createSearxngProviderFromEnv } from './providers/searxng';

export const isLocalWebSearchConfigured = (): boolean => {
  return Boolean(createSearxngProviderFromEnv());
};
