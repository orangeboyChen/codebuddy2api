/**
 * Configuration the console owns, handed to the backends that need it.
 *
 * The registry cannot read these itself: `domain/config` imports back into
 * `search`, so a lookup here would close an import cycle. Callers resolve the
 * settings — they are already async — and pass them in.
 *
 * Keys are optional because most deployments configure one backend and leave
 * the rest empty; a backend whose credential is missing resolves to no provider
 * rather than to a provider guaranteed to fail.
 */

export interface SearchBackendSettings {
  braveApiKey?: string;
  bingApiKey?: string;
  duckduckgoRegion?: string;
  exaApiKey?: string;
  searxngApiKey?: string;
  searxngUrl?: string;
  serperApiKey?: string;
  tavilyApiKey?: string;
}

export interface FetchBackendSettings {
  browserableApiKey?: string;
  browserableUrl?: string;
  jinaApiKey?: string;
}

export interface ResolveBackendOptions {
  fetch?: FetchBackendSettings;
  resolveEndpoint?: () => Promise<string>;
  search?: SearchBackendSettings;
}
