import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { locales } from '@/lib/i18n/routing';

const repoRoot = process.cwd();
const messagesDir = path.join(repoRoot, 'messages');

/** Read one locale file and return its sorted leaf key paths. */
const readLocaleKeys = (locale: string): string[] => {
  return Object.keys(readLocaleValues(locale)).sort();
};

/** Read one locale file and return its leaf key paths mapped to values. */
const readLocaleValues = (locale: string): Record<string, unknown> => {
  const filePath = path.join(messagesDir, `${locale}.json`);
  const contents = fs.readFileSync(filePath, 'utf8');

  return flattenValues(JSON.parse(contents) as unknown);
};

/** Flatten a nested message tree into dot-separated leaf key paths. */
const flattenValues = (
  value: unknown,
  prefix = '',
): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return prefix ? { [prefix]: value } : {};
  }

  return Object.entries(value as Record<string, unknown>).reduce<
    Record<string, unknown>
  >((result, [key, child]) => {
    return Object.assign(
      result,
      flattenValues(child, prefix ? `${prefix}.${key}` : key),
    );
  }, {});
};

/** Keys present in `source` but absent from `target`, in stable order. */
const difference = (source: Set<string>, target: Set<string>): string[] =>
  [...source].filter((key) => !target.has(key)).sort();

/** The locale the others are translated from. */
const REFERENCE_LOCALE = 'en-US';

const localePairs = locales.flatMap((left, index) =>
  locales.slice(index + 1).map((right) => [left, right] as const),
);

describe('locale message parity', () => {
  it('reads a non-empty message tree for every locale', () => {
    for (const locale of locales) {
      expect(readLocaleKeys(locale).length).toBeGreaterThan(0);
    }
  });

  it.each(localePairs)(
    '%s and %s expose the same message keys',
    (left, right) => {
      const leftKeys = new Set(readLocaleKeys(left));
      const rightKeys = new Set(readLocaleKeys(right));
      const missingInLeft = difference(rightKeys, leftKeys);
      const missingInRight = difference(leftKeys, rightKeys);

      // next-intl has no fallback locale, so a missing key renders its path.
      const mismatches: Record<string, string[]> = {};
      if (missingInLeft.length > 0) {
        mismatches[`missing in ${left}`] = missingInLeft;
      }
      if (missingInRight.length > 0) {
        mismatches[`extra in ${left}`] = missingInRight;
      }

      expect(mismatches).toEqual({});
    },
  );

  it.each(locales)('%s has no empty message values', (locale) => {
    // A key that exists but holds nothing renders as nothing, which is the
    // same user-visible failure a missing key produces.
    const empties = Object.entries(readLocaleValues(locale))
      .filter(([, value]) => typeof value === 'string' && !value.trim())
      .map(([key]) => key);

    expect(empties).toEqual([]);
  });

  it.each(locales.filter((locale) => locale !== REFERENCE_LOCALE))(
    '%s is actually translated from %s',
    (locale) => {
      // Guards the other half of parity: identical key sets say nothing about
      // whether anyone translated the values. Copying the reference file
      // wholesale has to fail.
      const reference = readLocaleValues(REFERENCE_LOCALE);
      const translated = readLocaleValues(locale);
      const shared = Object.keys(reference).filter((key) =>
        Object.hasOwn(translated, key),
      );
      const untranslated = shared.filter((key) => {
        const value = translated[key];

        return (
          typeof value === 'string' &&
          typeof reference[key] === 'string' &&
          value.trim() === (reference[key] as string).trim()
        );
      });

      // A handful of locale-independent values (model names, units, "OK") are
      // legitimately identical, so require most of the file to differ rather
      // than all of it.
      const translatedShare =
        (shared.length - untranslated.length) / shared.length;

      expect(untranslated.length).toBeLessThan(shared.length);
      expect(translatedShare).toBeGreaterThan(0.8);
    },
  );
});
