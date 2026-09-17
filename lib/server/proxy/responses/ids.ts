/**
 * Identifier minting for Responses objects.
 *
 * Every id is a short protocol prefix plus a UUID, which is what the Responses
 * API expects and what clients key their own bookkeeping off. They live apart
 * from the payload builder because the transcript layer needs them too, and
 * reaching back into the payload for an id would make the two circular.
 */

export const createResponseId = (): string => {
  return `resp_${crypto.randomUUID().replaceAll('-', '')}`;
};

export const createMessageId = (): string => {
  return `msg_${crypto.randomUUID().replaceAll('-', '')}`;
};

export const createResponseReasoningId = (): string => {
  return `rs_${crypto.randomUUID().replaceAll('-', '')}`;
};

export const createResponseOutputId = (): string => {
  return `fc_${crypto.randomUUID().replaceAll('-', '')}`;
};

/**
 * Rewrites an Anthropic-style tool-call id into the `call_` shape OpenAI
 * clients expect. An id the upstream already minted is returned untouched, so
 * only synthetic ids are normalised.
 */
export const normalizeToolCallId = (
  id: string | undefined,
  index: number,
): string => {
  if (id && !id.startsWith('tooluse_')) {
    return id;
  }

  return `call_${id?.replace(/^tooluse_/, '') ?? index + 1}`;
};
