// ---------------------------------------------------------------------------
// OpenAI Responses API types
// ---------------------------------------------------------------------------

export interface ResponsesInputItem {
  type?: string;
  role?: string;
  content?: unknown;
  text?: string;
  arguments?: string;
  output?: unknown;
  name?: string;
  call_id?: string;
  tools?: Array<{ type?: string; name?: string } & Record<string, unknown>>;
  /**
   * Present on `reasoning` items a client replays from an earlier response.
   * We put the reasoning here verbatim; clients echo it back untouched.
   * A compaction item carries the same field.
   */
  encrypted_content?: string;
  /**
   * Reasoning summaries. The Agents SDK sends these back as
   * `summary: [{type: 'summary_text', text}]`.
   */
  summary?: unknown;
}

export interface SupportedChatTool {
  chatName: string;
  kind: 'custom' | 'function' | 'mcp' | 'tool_search';
  namespace?: string;
  originalName: string;
  /**
   * The type the client declared this tool with, when it asked the *provider*
   * to run it (`web_search_preview`, `web_fetch_20250910`) rather than
   * declaring a function of its own.
   *
   * Translation keeps that type on the chat tool instead of flattening it to
   * `function`, which is what lets the proxy recognise a provider-executed
   * declaration after translation. A client's own function — including one
   * named `web_search` — arrives as `function` and is left to the client.
   */
  serverType?: string;
  serverLabel?: string;
  /**
   * The client's declaration, untouched.
   *
   * `toSupportedChatTool` synthesises a fresh object, so anything the client
   * set that the proxy has no field for — `max_uses`, `allowed_domains`,
   * `user_location` — would otherwise vanish before the turn reads it.
   */
  declaration?: Record<string, unknown>;
  tool: Record<string, unknown>;
}

export interface ResponsesRequestBody {
  model?: string;
  input?: string | ResponsesInputItem[];
  instructions?: string;
  /**
   * A chat-shaped request posted to this route. Reasoning rides along on the
   * message, in whichever spelling the client replays: `reasoning_content` is
   * what we hand back, `reasoning` is what we ourselves put on a transcript.
   */
  messages?: Array<{
    role?: string;
    content?: unknown;
    reasoning?: unknown;
    reasoning_content?: unknown;
  }>;
  stream?: boolean;
  metadata?: Record<string, unknown>;
  reasoning?: Record<string, unknown>;
  thinking?: Record<string, unknown>;
  tools?: Array<{ type?: string; name?: string } & Record<string, unknown>>;
  tool_choice?: unknown;
  max_output_tokens?: number;
  previous_response_id?: string;
}

export type ResponseSessionDefaults = Pick<
  ResponsesRequestBody,
  'instructions' | 'metadata' | 'tools' | 'tool_choice'
>;

export interface ResponseSession {
  accessKeyId: string | null;
  credentialFilename: string | null;
  createdAt: number;
  id: string;
  model: string;
  transcript: TranscriptMessage[];
  defaults: ResponseSessionDefaults;
  upstreamProtocol?: 'chat' | 'responses';
}

export interface ChatResponseToolCall {
  index?: number;
  id?: string;
  type?: string;
  function?: {
    arguments?: string;
    name?: string;
  };
}

export interface ChatResponseMessage {
  content?: unknown;
  tool_calls?: ChatResponseToolCall[];
  /** Reasoning the upstream produced alongside `content`. */
  reasoning_content?: string;
  reasoning?: string;
}

export interface ChatImagePart {
  image_url: { url: string };
  type: 'image_url';
}

export interface ChatTextPart {
  text: string;
  type: 'text';
}

export type ChatContentPart = string | ChatTextPart | ChatImagePart;

/**
 * Transcript content. Images are kept as structured parts so they survive the
 * Chat-shaped round trip through the transcript and reach the model as images
 * instead of a JSON dump.
 */
export type TranscriptContent = string | ChatContentPart[];

export interface TranscriptMessage {
  role: string;
  content: TranscriptContent | null;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
  /**
   * Prior-turn reasoning recovered from a replayed reasoning item.
   *
   * Carried on the assistant message the reasoning belongs to rather than sent
   * as its own message: the chat upstream has no standalone reasoning entry,
   * and a reasoning-only message would be an empty turn.
   */
  reasoning?: string;
}

export interface StreamingToolCallState {
  addedEmitted: boolean;
  arguments: string;
  canonicalKey: string;
  callId: string;
  name: string;
  outputIndex: number;
  outputItemId: string;
  pendingArgumentDeltas: string[];
}

export interface StreamingMessageState {
  outputIndex: number | null;
  outputItemId: string;
}

export interface ResponsesServerToolItem {
  completed: Record<string, unknown>;
  inProgress: Record<string, unknown>;
  outputIndex: number;
}

export interface ResponseSessionMetadata {
  bytes: number;
  createdAt: number;
}

export type SupportedResponsesTool = NonNullable<
  ResponsesRequestBody['tools']
>[number];
