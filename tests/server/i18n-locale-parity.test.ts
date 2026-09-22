import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { locales } from '@/lib/i18n/routing';

const repoRoot = process.cwd();
const messagesDir = path.join(repoRoot, 'messages');

/** Flatten a nested message tree into dot-separated leaf key paths. */
const flattenKeys = (value: unknown, prefix = ''): string[] => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }

  return Object.entries(value as Record<string, unknown>).flatMap(
    ([key, child]) => flattenKeys(child, prefix ? `${prefix}.${key}` : key),
  );
};

/** Read one locale file and return its sorted leaf key paths. */
const readLocaleKeys = (locale: string): string[] => {
  const filePath = path.join(messagesDir, `${locale}.json`);
  const contents = fs.readFileSync(filePath, 'utf8');

  return flattenKeys(JSON.parse(contents) as unknown).sort();
};

/** Keys present in `source` but absent from `target`, in stable order. */
const difference = (source: Set<string>, target: Set<string>): string[] =>
  [...source].filter((key) => !target.has(key)).sort();

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
});
