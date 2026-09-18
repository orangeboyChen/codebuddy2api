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

/**
 * How many searches one request may run when the client does not say.
 *
 * Anthropic's own default. A client that cares sends `max_uses` on the
 * declaration; this is only the fallback for one that does not.
 */
export const DEFAULT_MAX_SEARCH_USES = 5;

/**
 * Ceiling on a client-declared `max_uses`.
 *
 * Every use is a sequential upstream round trip, so an unbounded value is an
 * unbounded request: `max_uses: 1000` would hold the connection for a thousand
 * calls. Generous enough that no real client is constrained.
 */
export const MAX_SEARCH_USES_CEILING = 20;

/**
 * The search budget the client asked for.
 *
 * Anthropic declares it as `max_uses` on the server tool, and it bounds the
 * whole turn rather than each hop: a model that refines its query twice has
 * used two of the eight, not two of eight per round.
 */
/**
 * The `max_uses` the client declared for one server tool.
 *
 * Read per kind, never merged: `max_uses` is declared on the individual tool,
 * so a fetch's budget must not cap the searches, nor the other way round.
 */
export const readMaxUses = (tools: unknown, kind: ServerToolKind): number => {
  if (!Array.isArray(tools)) {
    return DEFAULT_MAX_SEARCH_USES;
  }

  const declared = tools
    .filter((tool) => classifyServerToolDeclaration(tool) === kind)
    .map((tool) => asRecord(tool)?.max_uses)
    .filter((value): value is number => typeof value === 'number')
    .filter((value) => Number.isFinite(value) && value >= 0);

  if (!declared.length) {
    return DEFAULT_MAX_SEARCH_USES;
  }

  return Math.min(MAX_SEARCH_USES_CEILING, Math.floor(Math.min(...declared)));
};

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
    // Exact, not normalised. Normalising makes `WebSearch` and `web_search`
    // the same string, so a client declaring its own `WebSearch` next to the
    // server tool looked like a collision and had the whole server-tool
    // feature switched off — the declarations are already told apart by
    // their declared type, so the names never needed comparing loosely.
    const name = declarationName(tool);

    if (!name) {
      return;
    }

    if (classifyServerToolDeclaration(tool)) {
      serverNames.add(name);
    } else {
      clientNames.add(name);
    }
  });

  return [...serverNames].some((name) => clientNames.has(name));
};

export interface RewrittenServerTools {
  /** How many calls of each kind this turn may make; see {@link readMaxUses}. */
  maxUses: { web_fetch: number; web_search: number };
  /**
   * Which server tool a call names, or `null` when the call is not one the
   * proxy injected. Matched exactly — see the note in {@link rewriteServerTools}.
   */
  classifyCall: (toolCall: ChatCompletionToolCall) => ServerToolKind | null;
  /**
   * Which declared server tools the proxy will execute. A declaration the proxy
   * cannot run — no backend configured — is still rewritten upstream, but is
   * left for the client to resolve.
   */
  executable: ServerToolDeclarations;
  /** Sorts a tool call into one the proxy runs and one the client resolves. */
  isExecutableCall: (toolCall: ChatCompletionToolCall) => boolean;
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

  const maxUses = {
    web_fetch: readMaxUses(tools, 'web_fetch'),
    web_search: readMaxUses(tools, 'web_search'),
  };

  const executable: ServerToolDeclarations = {
    fetch: declarations.fetch && Boolean(fetchProvider) && !ambiguous,
    search: declarations.search && Boolean(searchProvider) && !ambiguous,
  };

  /**
   * Which server tool each name the proxy injected belongs to.
   *
   * Keyed by the exact name first. `search/tool.ts` records that upstream
   * echoes these back respelled — `WebSearch`, `Web Fetch` — so the normalised
   * form is registered too, but only when the client declared no colliding
   * name of its own; see the note at the registration site.
   *
   * A miss is not an error to be recovered from. It means the call is not
   * ours, and it goes back to the client — which is the safe direction to be
   * wrong in.
   */
  const definitions = new Map<string, ServerToolKind>();

  /** Whether the proxy runs `kind`, as opposed to leaving it to the client. */
  const runsLocally = (kind: ServerToolKind): boolean =>
    kind === 'web_search' ? executable.search : executable.fetch;

  const rewritten = tools.flatMap<unknown>((tool) => {
    const kind = classifyServerToolDeclaration(tool);

    if (!kind) {
      return [tool];
    }

    // Withdrawn rather than offered when nothing here can run it. Offering it
    // anyway would have the model call it and hand the client a `tool_use` for
    // a name it declared as a *provider-executed* tool and has no handler for
    // — no search, and a turn the client cannot complete. Answering from
    // memory is the honest degradation.
    if (!runsLocally(kind)) {
      return [];
    }

    const definition =
      kind === 'web_search'
        ? buildWebSearchToolDefinition()
        : buildWebFetchToolDefinition();

    definitions.set(definition.name, kind);

    // Stays callable on every hop: the model decides when it has enough, and
    // removing it here would forbid exactly the follow-up search that makes a
    // server tool worth having.
    return [{ type: 'function', function: definition }];
  });

  /**
   * Which server tool `toolCall` names, or `null` when it is not one of ours.
   *
   * Compared exactly, for the reason above.
   */
  const classifyCall = (
    toolCall: ChatCompletionToolCall,
  ): ServerToolKind | null => {
    const name = toolCall.function?.name;

    if (typeof name !== 'string') {
      return null;
    }

    // Exact first; the normalised spelling is only a fallback, registered
    // solely when nothing collides, for an upstream that respells the name it
    // was given. Looking up the raw name alone would make that fallback dead.
    return (
      definitions.get(name) ?? definitions.get(normalizeToolName(name)) ?? null
    );
  };

  /**
   * Respelled names are only safe to claim when no client function normalises
   * onto one of ours.
   *
   * A *normalised* test even though `hasAmbiguousServerToolName` is an exact
   * one, and deliberately so: the fallback matches in normalised space, so
   * that is where its safety has to be judged. A client declaring its own
   * `WebSearch` must keep it — otherwise the proxy would answer exactly the
   * call that client declared the tool to handle itself.
   */
  const clientNormalised = new Set(
    tools
      .filter((tool) => !classifyServerToolDeclaration(tool))
      .map((tool) => normalizeToolName(declarationName(tool))),
  );

  for (const [name, kind] of [...definitions]) {
    if (!clientNormalised.has(normalizeToolName(name))) {
      definitions.set(normalizeToolName(name), kind);
    }
  }

  /** Whether the proxy runs this call, as opposed to leaving it to the client. */
  const isExecutableCall = (toolCall: ChatCompletionToolCall): boolean => {
    const kind = classifyCall(toolCall);

    return kind ? runsLocally(kind) : false;
  };

  return {
    classifyCall,
    executable,
    isExecutableCall,
    maxUses,
    tools: rewritten,
  };
};

/**
 * Drops a `tool_choice` that names a tool no longer on offer.
 *
 * Withdrawing a server tool nothing here can run leaves a forced choice
 * pointing at it otherwise, and an upstream that validates the two together
 * rejects the request instead of letting the model answer from memory.
 */
export const reconcileToolChoice = (
  toolChoice: unknown,
  tools: unknown,
): unknown => {
  const name = getForcedToolName(toolChoice);

  if (!name || !Array.isArray(tools)) {
    return toolChoice;
  }

  const offered = tools.some(
    (tool) => asRecord(asRecord(tool)?.function)?.name === name,
  );

  return offered ? toolChoice : undefined;
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
