import { asRecord } from '../../shared/content';
import {
  buildWebFetchToolDefinition,
  buildWebSearchToolDefinition,
  isMarkedServerTool,
  normalizeToolName,
  stripServerToolMarker,
  WEB_FETCH_TOOL_NAME,
  WEB_FETCH_TOOL_TYPE_PREFIX,
  WEB_SEARCH_TOOL_NAME,
  WEB_SEARCH_TOOL_TYPE_PREFIX,
} from '../../search/tool';
import type { WebFetchProvider, WebSearchProvider } from '../../search/types';
import type { ChatCompletionToolCall } from './types';

/**
 * Recognises one server-tool declaration.
 *
 * Anthropic sends dated server-tool *types* (`web_search_20260209`,
 * `web_fetch_20250910`), Responses sends `web_search_preview`, and a client may
 * also declare a plain function tool with the bare name for its own purposes.
 * All three shapes have to match, because the tool has to be swapped for a
 * function upstream can actually call regardless of how it arrived.
 *
 * Returns two independent answers. `matches` says the declaration is one this
 * proxy can serve; `serverDeclared` says it arrived as a provider-executed
 * server tool rather than as the client's own function. The difference decides
 * what happens when the tool cannot be executed: a server-tool declaration is
 * dropped, because upstream has no idea what to do with it, whereas the
 * client's own function is left exactly as sent — the client is the one that
 * resolves it, and deleting it would silently remove a capability the client
 * asked for.
 */
export const classifyServerTool = (
  tool: unknown,
  name: string,
  prefix: string,
): { matches: boolean; serverDeclared: boolean } => {
  const record = asRecord(tool);

  if (!record) {
    return { matches: false, serverDeclared: false };
  }

  const type = typeof record.type === 'string' ? record.type : '';

  // A dedicated server-tool type (`web_search_20260209`, `web_fetch_20250910`,
  // `web_search_preview`) is unambiguous: only a provider-executed tool is
  // declared that way. The trailing date is part of the version, not the name,
  // so the prefix is matched in canonical form — `WebFetch_20250910` arrives
  // from upstream as readily as its snake_case spelling.
  if (normalizeToolName(type).startsWith(normalizeToolName(prefix))) {
    return { matches: true, serverDeclared: true };
  }

  const fn = asRecord(record.function);
  const isBareName =
    (typeof fn?.name === 'string' &&
      normalizeToolName(fn.name) === normalizeToolName(name)) ||
    (typeof record.name === 'string' &&
      normalizeToolName(record.name).startsWith(normalizeToolName(prefix)));

  // A Responses translation has already flattened the declaration into a plain
  // function, so the type is gone by now; its marker is the only surviving
  // evidence that the client asked for a provider-executed tool.
  return {
    matches: isBareName,
    serverDeclared: isBareName && isMarkedServerTool(tool),
  };
};

export const isWebSearchTool = (tool: unknown): boolean =>
  classifyServerTool(tool, WEB_SEARCH_TOOL_NAME, WEB_SEARCH_TOOL_TYPE_PREFIX)
    .matches;

export const isWebFetchTool = (tool: unknown): boolean =>
  classifyServerTool(tool, WEB_FETCH_TOOL_NAME, WEB_FETCH_TOOL_TYPE_PREFIX)
    .matches;

export const isServerDeclaredSearchTool = (tool: unknown): boolean =>
  classifyServerTool(tool, WEB_SEARCH_TOOL_NAME, WEB_SEARCH_TOOL_TYPE_PREFIX)
    .serverDeclared;

export const isServerDeclaredFetchTool = (tool: unknown): boolean =>
  classifyServerTool(tool, WEB_FETCH_TOOL_NAME, WEB_FETCH_TOOL_TYPE_PREFIX)
    .serverDeclared;

/**
 * Whether `toolCall` is a call the proxy is meant to execute.
 *
 * Matched in canonical form because the name comes back from the model, which
 * is under no obligation to repeat the spelling it was given: upstream echoes
 * `web_fetch` as `WebFetch` often enough to matter here. A miss is not a
 * fallback to the client — the call leaves the loop as an unanswered
 * client-owned tool, so the fetch silently never happens.
 */
export const isWebSearchToolCall = (
  toolCall: ChatCompletionToolCall,
): boolean => {
  return (
    typeof toolCall.function?.name === 'string' &&
    normalizeToolName(toolCall.function.name) ===
      normalizeToolName(WEB_SEARCH_TOOL_NAME)
  );
};

export const isWebFetchToolCall = (
  toolCall: ChatCompletionToolCall,
): boolean => {
  return (
    typeof toolCall.function?.name === 'string' &&
    normalizeToolName(toolCall.function.name) ===
      normalizeToolName(WEB_FETCH_TOOL_NAME)
  );
};

/**
 * Swaps locally executed server-tool declarations for functions upstream can
 * call. Passthrough tools keep their upstream representation.
 *
 * Returns `null` when no web tool is present. `executes` distinguishes a local
 * backend from passthrough: the latter still strips the internal provenance
 * marker, but never starts the server loop or buffers a stream.
 */
export const replaceServerTools = ({
  fetchEnabled,
  fetchProvider,
  searchEnabled,
  searchPassthrough,
  searchProvider,
  tools,
}: {
  fetchEnabled: boolean;
  fetchProvider: WebFetchProvider | null;
  searchEnabled: boolean;
  searchPassthrough: boolean;
  searchProvider: WebSearchProvider | null;
  tools: unknown;
}): {
  executes: boolean;
  /** Canonical names the proxy took over, so call classification can tell its own calls from a client's. */
  ownedNames: Set<string>;
  tools: unknown[];
} | null => {
  if (!Array.isArray(tools) || !tools.length) {
    return null;
  }

  let matched = false;
  let executes = false;
  // Names the proxy is executing itself. A client may declare its own tool
  // under the same name, and the loop must not answer those calls: matching
  // the name is not enough to own it.
  const ownedNames = new Set<string>();

  const rewritten = tools.flatMap((tool): unknown[] => {
    if (isWebSearchTool(tool)) {
      if (searchEnabled && searchProvider) {
        matched = true;
        executes = true;
        ownedNames.add(normalizeToolName(WEB_SEARCH_TOOL_NAME));

        return [{ type: 'function', function: buildWebSearchToolDefinition() }];
      }

      if (!isServerDeclaredSearchTool(tool)) {
        return [tool];
      }

      matched = true;
      return searchPassthrough ? [stripServerToolMarker(tool)] : [];
    }

    if (isWebFetchTool(tool)) {
      // A client-owned function of the same name wins over the backend, exactly
      // as it does for search. The backend setting chooses who runs the *proxy's*
      // tool; it is not a licence to take over a tool the client declared and
      // resolves itself. Without this, a client that ships its own `web_fetch`
      // loses it the moment a deployment picks a backend.
      if (!isServerDeclaredFetchTool(tool)) {
        return [tool];
      }

      if (fetchEnabled && fetchProvider) {
        matched = true;
        executes = true;
        ownedNames.add(normalizeToolName(WEB_FETCH_TOOL_NAME));

        return [{ type: 'function', function: buildWebFetchToolDefinition() }];
      }

      matched = true;
      return [stripServerToolMarker(tool)];
    }

    // The marker is internal to this proxy, so it never reaches upstream.
    return [stripServerToolMarker(tool)];
  });

  return matched ? { executes, ownedNames, tools: rewritten } : null;
};

/**
 * Whether the proxy is the one meant to answer this call.
 *
 * A call without an available backend is not a fallback to the client — it
 * leaves the loop as an unanswered client-owned tool — but it must not be
 * counted as locally executable either.
 */
export const isLocalServerToolCall = ({
  fetchProvider,
  ownedNames,
  toolCall,
  searchProvider,
}: {
  fetchProvider: WebFetchProvider | null;
  /**
   * Canonical names the proxy took over. Without it a client's own tool that
   * happens to share a name — `web_fetch`, which is not a server tool in the
   * Responses API — gets executed by the loop instead of handed back.
   */
  ownedNames?: Set<string>;
  toolCall: ChatCompletionToolCall;
  searchProvider: WebSearchProvider | null;
}): boolean =>
  (Boolean(searchProvider) &&
    isWebSearchToolCall(toolCall) &&
    isOwned(ownedNames, WEB_SEARCH_TOOL_NAME)) ||
  (Boolean(fetchProvider) &&
    isWebFetchToolCall(toolCall) &&
    isOwned(ownedNames, WEB_FETCH_TOOL_NAME));

/**
 * Whether the proxy owns calls to `name`.
 *
 * `undefined` means the caller predates ownership tracking; those callers only
 * ever run the proxy's own declarations, so they are unaffected by client tools
 * of the same name.
 */
export const isOwned = (
  ownedNames: Set<string> | undefined,
  name: string,
): boolean => !ownedNames || ownedNames.has(normalizeToolName(name));
