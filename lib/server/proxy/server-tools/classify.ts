import {
  buildWebFetchToolDefinition,
  buildWebSearchToolDefinition,
  normalizeToolName,
  WEB_FETCH_TOOL_TYPE_PREFIX,
  WEB_SEARCH_TOOL_TYPE_PREFIX,
} from '../../search/tool';
import { asRecord } from '../../shared/content';
import type { ChatCompletionToolCall, ServerToolKind } from './types';

/**
 * Decides which tool declarations the provider — this proxy — is meant to run,
 * and rewrites them into functions upstream can call.
 *
 * ## Only the declared type counts
 *
 * A provider-executed tool is declared with a type of its own: Anthropic sends
 * `web_search_20250305` and `web_fetch_20250910`, the Responses API sends
 * `web_search_preview`. A client's own function is declared as
 * `{type: 'function', function: {...}}` on OpenAI, or as a bare
 * `{name, input_schema}` with no type at all on Anthropic. So the type is both
 * necessary and sufficient to tell them apart.
 *
 * The name is deliberately never consulted. `normalizeToolName` strips case and
 * separators — `WebSearch` and `web_search` both become `websearch` — so a
 * name-based test cannot tell Claude Code's own `WebSearch` function from the
 * server tool. Matching on the name made the proxy answer a call the client had
 * every intention of resolving itself: Claude Code never received the
 * `tool_use` block it needed, so the search it asked for never happened and the
 * turn ended with an answer invented from memory.
 *
 * The distinction is what the corrected flow turns on. Claude Code declares
 * `WebSearch` as an ordinary function and resolves it itself; only when it has
 * a `WebSearch` result to fill in does it issue a sub-request whose tools carry
 * the server type, and that sub-request is the one that runs here.
 */

const SERVER_TOOL_PREFIXES: ReadonlyArray<{
  kind: ServerToolKind;
  prefix: string;
}> = [
  { kind: 'web_search', prefix: WEB_SEARCH_TOOL_TYPE_PREFIX },
  { kind: 'web_fetch', prefix: WEB_FETCH_TOOL_TYPE_PREFIX },
];

const OPENAI_FUNCTION_TYPE = 'function';

/**
 * Classifies one tool declaration, or returns `null` for a client-owned tool.
 */
export const classifyServerToolDeclaration = (
  tool: unknown,
): ServerToolKind | null => {
  const record = asRecord(tool);

  if (!record) {
    return null;
  }

  const type = typeof record.type === 'string' ? record.type.trim() : '';

  // No type is Anthropic's shorthand for a client function, and `function` is
  // OpenAI's. Both mean the client resolves the call, whatever the tool is
  // called — including when it is called `web_search`.
  if (!type || normalizeToolName(type) === OPENAI_FUNCTION_TYPE) {
    return null;
  }

  const normalized = normalizeToolName(type);
  const match = SERVER_TOOL_PREFIXES.find(({ prefix }) =>
    normalized.startsWith(normalizeToolName(prefix)),
  );

  return match?.kind ?? null;
};

export interface ServerToolDeclarations {
  fetch: boolean;
  search: boolean;
}

/** The provider-executed declarations in `tools`, or `null` when there are none. */
export const findServerToolDeclarations = (
  tools: unknown,
): ServerToolDeclarations | null => {
  if (!Array.isArray(tools) || !tools.length) {
    return null;
  }

  const kinds = new Set(
    tools
      .map(classifyServerToolDeclaration)
      .filter((kind): kind is ServerToolKind => kind !== null),
  );

  if (!kinds.size) {
    return null;
  }

  return { fetch: kinds.has('web_fetch'), search: kinds.has('web_search') };
};

const declarationName = (tool: unknown): string => {
  const record = asRecord(tool);
  const fn = asRecord(record?.function);

  return typeof fn?.name === 'string'
    ? fn.name
    : typeof record?.name === 'string'
      ? record.name
      : '';
};

/**
 * Whether any client-owned function collides with a server tool the proxy is
 * about to inject.
 *
 * Both would arrive upstream under the same name, and a model calling it gets
 * no way to say which it meant — so the call is left to the client rather than
 * guessed at. This is the same normalization collision this file exists to
 * avoid, reached from the other side: two declarations this time, one by type
 * and one by name, that upstream cannot tell apart.
 */
export const hasAmbiguousServerToolName = (tools: unknown): boolean => {
  if (!Array.isArray(tools)) {
    return false;
  }

  const serverNames = new Set<string>();
  const clientNames = new Set<string>();

  tools.forEach((tool) => {
    const name = normalizeToolName(declarationName(tool));

    if (!name) {
      return;
    }

    if (classifyServerToolDeclaration(tool)) {
      serverNames.add(name);
    } else {
      clientNames.add(name);
    }
  });

  return [...serverNames].some((name) =>
    [...clientNames].some((client) => name === client),
  );
};

export interface RewrittenServerTools {
  /**
   * Which declared server tools the proxy will execute. A declaration the proxy
   * cannot run — no backend configured — is still rewritten upstream, but is
   * left for the client to resolve.
   */
  executable: ServerToolDeclarations;
  /** Sorts a tool call into one the proxy runs and one the client resolves. */
  isExecutableCall: (toolCall: ChatCompletionToolCall) => boolean;
  /**
   * Declarations for the follow-up call, with the executed server tools
   * removed. They are dropped rather than left callable because the follow-up
   * exists to write the answer, and a second search there would be a second
   * turn this proxy does not run.
   */
  followUpTools: unknown[];
  tools: unknown[];
}

/**
 * Replaces provider-executed declarations with the functions upstream calls.
 *
 * Upstream has no server tools, so every provider-executed declaration —
 * runnable or not — has to become a plain function before it goes out; leaving
 * the declared type in place would send a shape upstream rejects.
 *
 * Returns `null` when no provider-executed tool is declared, so a caller can
 * skip the turn entirely and forward the request untouched.
 */
export const rewriteServerTools = ({
  declarations,
  fetchProvider,
  searchProvider,
  tools,
}: {
  declarations: ServerToolDeclarations;
  fetchProvider: unknown;
  searchProvider: unknown;
  tools: unknown[];
}): RewrittenServerTools => {
  // Ambiguity is resolved in the client's favour; see
  // {@link hasAmbiguousServerToolName}.
  const ambiguous = hasAmbiguousServerToolName(tools);

  const executable: ServerToolDeclarations = {
    fetch: declarations.fetch && Boolean(fetchProvider) && !ambiguous,
    search: declarations.search && Boolean(searchProvider) && !ambiguous,
  };

  const injectedNames = new Set<string>();
  const definitions = new Map<string, ServerToolKind>();
  const followUpTools: unknown[] = [];

  /** Whether the proxy runs `kind`, as opposed to leaving it to the client. */
  const runsLocally = (kind: ServerToolKind): boolean =>
    kind === 'web_search' ? executable.search : executable.fetch;

  const rewritten = tools.map((tool) => {
    const kind = classifyServerToolDeclaration(tool);

    if (!kind) {
      followUpTools.push(tool);
      return tool;
    }

    const definition =
      kind === 'web_search'
        ? buildWebSearchToolDefinition()
        : buildWebFetchToolDefinition();

    injectedNames.add(normalizeToolName(definition.name));
    definitions.set(normalizeToolName(definition.name), kind);

    // A declaration the proxy is not running stays callable on the follow-up:
    // the client is the one that answers it, and dropping it would silently
    // remove a tool the client asked for.
    if (!runsLocally(kind)) {
      followUpTools.push({ type: 'function', function: definition });
    }

    return { type: 'function', function: definition };
  });

  /**
   * Only a name the proxy injected, and only for a tool it has a backend for.
   *
   * Matched in canonical form because the name comes back from the model, which
   * is under no obligation to repeat the spelling it was given: upstream echoes
   * `web_fetch` as `WebFetch` often enough to matter here.
   */
  const isExecutableCall = (toolCall: ChatCompletionToolCall): boolean => {
    const name = normalizeToolName(toolCall.function?.name ?? '');
    const kind = definitions.get(name);

    return kind ? runsLocally(kind) : false;
  };

  return { executable, followUpTools, isExecutableCall, tools: rewritten };
};

/** Whether the proxy will run any server tool at all. */
export const hasExecutableServerTool = (
  executable: ServerToolDeclarations,
): boolean => executable.fetch || executable.search;

/**
 * The tool a `tool_choice` forces, in either protocol's shape.
 *
 * Anthropic sends `{type: 'tool', name}` and OpenAI `{type: 'function',
 * function: {name}}`; a translated body carries the OpenAI shape, while a
 * caller reading the client's own request sees the Anthropic one.
 */
export const getForcedToolName = (toolChoice: unknown): string | null => {
  const record = asRecord(toolChoice);

  if (!record) {
    return null;
  }

  const fn = asRecord(record.function);

  return typeof fn?.name === 'string'
    ? fn.name
    : typeof record.name === 'string'
      ? record.name
      : null;
};
