import {
  sealReasoning,
  unsealReasoning,
} from '@/lib/server/shared/reasoning-seal';

const KEY = 'test-seal-secret';

describe('reasoning seals', () => {
  const originalKey = process.env.CODEBUDDY_STORAGE_ENCRYPTION_KEY;

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.CODEBUDDY_STORAGE_ENCRYPTION_KEY;
    } else {
      process.env.CODEBUDDY_STORAGE_ENCRYPTION_KEY = originalKey;
    }
  });

  describe('with a key configured', () => {
    beforeEach(() => {
      process.env.CODEBUDDY_STORAGE_ENCRYPTION_KEY = KEY;
    });

    it('round-trips reasoning', () => {
      const sealed = sealReasoning('the model thought about primes');

      expect(sealed).toBeDefined();
      expect(unsealReasoning(sealed)).toBe('the model thought about primes');
    });

    it('round-trips unicode and newlines without mangling', () => {
      const reasoning = '第一步：检查缓存。\nline two — em dash ✓';

      expect(unsealReasoning(sealReasoning(reasoning))).toBe(reasoning);
    });

    it('produces an opaque blob that does not contain the plaintext', () => {
      const sealed = sealReasoning('super secret reasoning');

      expect(sealed).toBeDefined();
      expect(sealed).not.toContain('super secret reasoning');
    });

    it('randomises the iv so sealing twice differs', () => {
      expect(sealReasoning('same input')).not.toBe(sealReasoning('same input'));
    });

    it('rejects a tampered blob instead of decrypting to garbage', () => {
      const sealed = sealReasoning('original reasoning') ?? '';
      const tampered = `${sealed.slice(0, -2)}${sealed.slice(-2) === 'AA' ? 'BB' : 'AA'}`;

      expect(unsealReasoning(tampered)).toBeUndefined();
    });
  });

  describe('without a key configured', () => {
    beforeEach(() => {
      delete process.env.CODEBUDDY_STORAGE_ENCRYPTION_KEY;
    });

    it('still round-trips via the plain fallback', () => {
      expect(unsealReasoning(sealReasoning('no key here'))).toBe('no key here');
    });

    it('returns undefined for a blob sealed under a key we no longer have', () => {
      process.env.CODEBUDDY_STORAGE_ENCRYPTION_KEY = KEY;
      const sealed = sealReasoning('sealed with a key') ?? '';
      delete process.env.CODEBUDDY_STORAGE_ENCRYPTION_KEY;

      expect(unsealReasoning(sealed)).toBeUndefined();
    });
  });

  describe('degenerate input', () => {
    beforeEach(() => {
      process.env.CODEBUDDY_STORAGE_ENCRYPTION_KEY = KEY;
    });

    it('returns undefined for empty reasoning so no signature is emitted', () => {
      expect(sealReasoning('')).toBeUndefined();
    });

    it('returns undefined for a foreign signature we cannot open', () => {
      // What a client replays when the block came from a real Anthropic call.
      expect(unsealReasoning('WaUjzkypQ2mUEVM36O2Txu....')).toBeUndefined();
    });

    it('returns undefined for non-string and empty input', () => {
      expect(unsealReasoning(undefined)).toBeUndefined();
      expect(unsealReasoning(null)).toBeUndefined();
      expect(unsealReasoning(42)).toBeUndefined();
      expect(unsealReasoning('')).toBeUndefined();
    });
  });
});
