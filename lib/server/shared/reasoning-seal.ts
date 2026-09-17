import crypto from 'node:crypto';

/**
 * Reasoning seals.
 *
 * Anthropic's `thinking` blocks carry a `signature`: an opaque, encrypted copy
 * of the full reasoning that a client echoes back unchanged on later turns so
 * the model can continue from where it left off. Codex's Responses reasoning
 * items carry `encrypted_content` for the same purpose.
 *
 * We are the API as far as our clients are concerned, so we mint and verify
 * these ourselves — nothing here talks to Anthropic. Two properties matter:
 *
 * - **Opaque and tamper-evident.** The client must not be able to read or
 *   forge the reasoning, exactly as with the real thing. aes-256-gcm gives
 *   both; the auth tag makes a modified blob fail to verify rather than
 *   decrypt to garbage.
 * - **Lossless.** Unsealing has to return the reasoning we sealed, because
 *   that string is what we hand back to the chat upstream.
 *
 * The key is the same environment secret the storage layer already uses, so
 * operators configure one thing. When it is absent we fall back to a plain
 * encoding instead of throwing: reasoning round-tripping is an enhancement,
 * and a deployment without the secret set should still proxy successfully.
 */

const SEAL_ENV = 'CODEBUDDY_STORAGE_ENCRYPTION_KEY';

/** Prefix marking the unencrypted fallback, so unseal never guesses. */
const PLAIN_PREFIX = 'cbr1:';

/** Prefix marking a sealed blob, carrying the iv and auth tag alongside it. */
const SEALED_PREFIX = 'cbs1:';

const IV_BYTES = 12;
const TAG_BYTES = 16;

const createSealKey = (): Buffer | null => {
  const source = process.env[SEAL_ENV]?.trim();

  if (!source) {
    return null;
  }

  return crypto.createHash('sha256').update(source).digest();
};

/**
 * Encodes prior-turn reasoning as an opaque value safe to hand to a client.
 *
 * Returns `undefined` for empty input so callers can omit the field entirely
 * rather than emit a signature for nothing — an empty thinking block is
 * meaningful to some clients and noise to others.
 */
export const sealReasoning = (reasoning: string): string | undefined => {
  if (!reasoning) {
    return undefined;
  }

  const key = createSealKey();

  if (!key) {
    return `${PLAIN_PREFIX}${Buffer.from(reasoning, 'utf8').toString(
      'base64url',
    )}`;
  }

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(reasoning, 'utf8')),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return `${SEALED_PREFIX}${Buffer.concat([iv, tag, ciphertext]).toString(
    'base64url',
  )}`;
};

/**
 * Recovers reasoning from a value produced by {@link sealReasoning}.
 *
 * Unrecognised or tampered input yields `undefined` rather than throwing: a
 * client may replay a genuine Anthropic signature (which we cannot decrypt) or
 * a block from another deployment, and either should degrade to "no prior
 * reasoning" instead of failing the request.
 */
export const unsealReasoning = (sealed: unknown): string | undefined => {
  if (typeof sealed !== 'string' || !sealed) {
    return undefined;
  }

  if (sealed.startsWith(PLAIN_PREFIX)) {
    try {
      const decoded = Buffer.from(
        sealed.slice(PLAIN_PREFIX.length),
        'base64url',
      ).toString('utf8');

      return decoded || undefined;
    } catch {
      return undefined;
    }
  }

  if (!sealed.startsWith(SEALED_PREFIX)) {
    return undefined;
  }

  const key = createSealKey();

  if (!key) {
    // Sealed under a key we no longer have (secret rotated away or unset).
    return undefined;
  }

  try {
    const buffer = Buffer.from(sealed.slice(SEALED_PREFIX.length), 'base64url');
    const iv = buffer.subarray(0, IV_BYTES);
    const tag = buffer.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const encrypted = buffer.subarray(IV_BYTES + TAG_BYTES);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]).toString('utf8');

    return plaintext || undefined;
  } catch {
    // Auth-tag mismatch (tampered) or malformed base64.
    return undefined;
  }
};
