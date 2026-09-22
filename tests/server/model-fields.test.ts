import { describe, expect, it, vi } from 'vitest';

import {
  MODEL_DESCRIPTION_MAX_LENGTH,
  normalizeModelFields,
  pruneInactivePromotions,
} from '@/lib/server/proxy/codebuddy/model-fields';

const normalize = (entry: Record<string, unknown>) =>
  normalizeModelFields(entry);

describe('normalizeModelFields', () => {
  it('drops a model without an id', () => {
    expect(normalize({ name: 'Nameless' })).toBeUndefined();
    expect(normalize({ id: '   ' })).toBeUndefined();
  });

  it('keeps only the fields the console knows', () => {
    expect(
      normalize({
        credits: 'x1.00',
        displayName: 'GLM 5.3',
        id: 'glm-5.3',
        // Anything upstream adds later is not something the card renders.
        iconUrl: 'https://example.test/icon.png',
        somethingElse: { deeply: 'nested' },
      }),
    ).toStrictEqual({
      capabilityTags: undefined,
      contextLengths: undefined,
      contextWindow: undefined,
      credits: 'x1.00',
      defaultEffort: undefined,
      descriptionEn: undefined,
      descriptionZh: undefined,
      displayName: 'GLM 5.3',
      id: 'glm-5.3',
      isDefault: undefined,
      isEnterprise: undefined,
      isFree: undefined,
      isInternal: undefined,
      maxAllowedSize: undefined,
      maxInputTokens: undefined,
      maxOutputTokens: undefined,
      onlyReasoning: undefined,
      promotion: undefined,
      relatedModels: undefined,
      supportedEfforts: undefined,
      supportsImages: undefined,
      supportsReasoning: undefined,
      supportsToolCall: undefined,
      tier: undefined,
      vendor: undefined,
    });
  });

  it('reads a limit as unknown rather than as zero', () => {
    const model = normalize({
      contextWindow: 0,
      id: 'zero',
      maxAllowedSize: 'soon',
      maxInputTokens: true,
      maxOutputTokens: {},
    });

    expect(model?.contextWindow).toBeUndefined();
    expect(model?.maxAllowedSize).toBeUndefined();
    expect(model?.maxInputTokens).toBeUndefined();
    expect(model?.maxOutputTokens).toBeUndefined();
  });

  it('caps the lists a model advertises', () => {
    const model = normalize({
      capabilityTags: Array.from({ length: 20 }, (_, index) => `tag-${index}`),
      contextLengths: Array.from({ length: 20 }, (_, index) => 1000 + index),
      id: 'verbose',
      relatedModels: Object.fromEntries(
        Array.from({ length: 20 }, (_, index) => [`v-${index}`, `id-${index}`]),
      ),
      supportedEfforts: Array.from(
        { length: 20 },
        (_, index) => `effort-${index}`,
      ),
    });

    expect(model?.capabilityTags).toHaveLength(8);
    expect(model?.contextLengths).toHaveLength(8);
    expect(model?.supportedEfforts).toHaveLength(8);
    expect(Object.keys(model?.relatedModels ?? {})).toHaveLength(8);
  });

  it('drops the entries a list cannot hold', () => {
    const model = normalize({
      capabilityTags: ['', '  ', 'craft', 'craft', 42, 'x'.repeat(200)],
      contextLengths: [0, -1, 'many', 200000, 200000],
      id: 'mixed',
      relatedModels: { lite: '', '': 'orphan', reasoning: 7, vision: 'ok' },
      supportedEfforts: ['high', 42],
    });

    expect(model?.capabilityTags).toStrictEqual(['craft']);
    expect(model?.contextLengths).toStrictEqual([200000]);
    expect(model?.supportedEfforts).toStrictEqual(['high']);
    expect(model?.relatedModels).toStrictEqual({ vision: 'ok' });
  });

  it('drops a list whose every entry is unusable', () => {
    const model = normalize({
      capabilityTags: ['', '   ', 42],
      contextLengths: [0, -5, 'many'],
      id: 'empty-lists',
      relatedModels: { '': 'orphan', lite: '  ' },
      supportedEfforts: [42],
    });

    expect(model?.capabilityTags).toBeUndefined();
    expect(model?.contextLengths).toBeUndefined();
    expect(model?.relatedModels).toBeUndefined();
    expect(model?.supportedEfforts).toBeUndefined();
  });

  it('drops a window that parses to no date', () => {
    // Month 13 matches the shape of a date and parses to nothing.
    expect(
      normalize({
        id: 'impossible',
        promotion: { endsAt: '2099-13-45T00:00:00Z' },
      })?.promotion?.endsAt,
    ).toBeUndefined();
  });

  it('caps the strings the card prints', () => {
    const model = normalize({
      credits: 'x'.repeat(300),
      defaultEffort: 'e'.repeat(300),
      displayName: 'N'.repeat(300),
      id: 'capped',
      promotion: {
        discountedCredits: 'd'.repeat(300),
        label: 'L'.repeat(300),
      },
      tier: { label: 'T'.repeat(300), level: 'v'.repeat(300) },
      vendor: 'V'.repeat(300),
    });

    // The id is left alone on purpose: routing matches on it verbatim.
    expect(model?.id).toBe('capped');
    expect(model?.credits).toHaveLength(64);
    expect(model?.defaultEffort).toHaveLength(64);
    expect(model?.displayName).toHaveLength(128);
    expect(model?.vendor).toHaveLength(64);
    expect(model?.promotion?.discountedCredits).toHaveLength(64);
    expect(model?.promotion?.label).toHaveLength(64);
    expect(model?.tier?.label).toHaveLength(64);
    expect(model?.tier?.level).toHaveLength(64);
  });

  it('keeps the first id of a variant written twice', () => {
    // `lite` and `lite ` name one variant; the first row wins.
    expect(
      normalize({
        id: 'twice',
        relatedModels: { lite: 'first', 'lite ': 'second' },
      })?.relatedModels,
    ).toStrictEqual({ lite: 'first' });
  });

  it('reads a variant named after an Object prototype member', () => {
    expect(
      normalize({
        id: 'proto',
        relatedModels: { constructor: 'a', toString: 'b', lite: 'c' },
      })?.relatedModels,
    ).toStrictEqual({ constructor: 'a', toString: 'b', lite: 'c' });
  });

  it('keeps a whole description full of astral characters', () => {
    const model = normalize({
      descriptionZh: '👍'.repeat(MODEL_DESCRIPTION_MAX_LENGTH + 50),
      id: 'emoji',
    });

    // Length is counted in characters, not UTF-16 units: one emoji is one
    // character and two units.
    expect([...(model?.descriptionZh ?? '')]).toHaveLength(
      MODEL_DESCRIPTION_MAX_LENGTH,
    );
    // A UTF-16 slice would end on a lone surrogate and render as a broken
    // glyph; a code-point slice ends on a whole one.
    expect(model?.descriptionZh?.endsWith('\uD83D\uDC4D')).toBe(true);
  });

  it('drops a window it cannot read in one zone only', () => {
    // No offset: read as local time here, as UTC elsewhere, so the printed day
    // would move. An offset or a bare date is unambiguous and survives.
    expect(
      normalize({ id: 'zone', promotion: { endsAt: '2099-10-01 00:00' } })
        ?.promotion?.endsAt,
    ).toBeUndefined();
    expect(
      normalize({ id: 'zone', promotion: { endsAt: '2099-10-01' } })?.promotion
        ?.endsAt,
    ).toBe('2099-10-01T00:00:00.000Z');
  });

  it('drops a promotion whose window has closed', () => {
    vi.useFakeTimers();

    try {
      vi.setSystemTime(new Date('2026-09-21T00:00:00.000Z'));

      expect(
        normalize({
          id: 'over',
          promotion: { endsAt: '2026-09-20T00:00:00.000Z', label: '已结束' },
        })?.promotion,
      ).toBeUndefined();
      expect(
        normalize({
          id: 'running',
          promotion: {
            endsAt: '2026-09-22T00:00:00.000Z',
            label: '进行中',
            startsAt: '2026-09-20T00:00:00.000Z',
          },
        })?.promotion,
      ).toStrictEqual({
        discountedCredits: undefined,
        endsAt: '2026-09-22T00:00:00.000Z',
        label: '进行中',
        startsAt: '2026-09-20T00:00:00.000Z',
        textEn: undefined,
        textZh: undefined,
      });
      // Not yet open, but kept: the catalog outlives the moment it was
      // fetched, so a campaign scheduled to open later has to reach the cache.
      expect(
        normalize({
          id: 'pending',
          promotion: { label: '未开始', startsAt: '2026-09-22T00:00:00.000Z' },
        })?.promotion?.startsAt,
      ).toBe('2026-09-22T00:00:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('trims a description instead of caching a book', () => {
    const model = normalize({
      descriptionZh: '描'.repeat(MODEL_DESCRIPTION_MAX_LENGTH + 50),
      id: 'long',
    });

    expect(model?.descriptionZh).toHaveLength(MODEL_DESCRIPTION_MAX_LENGTH);
  });

  it('reads a promotion, dropping a window it cannot print', () => {
    expect(
      normalize({
        id: 'promoted',
        promotion: {
          discountedCredits: 'x0.00',
          endsAt: 'whenever',
          label: '限时免费',
          textZh: '限时免费',
        },
      })?.promotion,
    ).toStrictEqual({
      discountedCredits: 'x0.00',
      endsAt: undefined,
      label: '限时免费',
      startsAt: undefined,
      textEn: undefined,
      textZh: '限时免费',
    });
  });

  it('normalises a promotion window to a timestamp', () => {
    // The offset is in the input: a bare date-time is read in whichever zone
    // the runner sits in, which would make this assertion zone-dependent.
    expect(
      normalize({
        id: 'promoted',
        promotion: { endsAt: '2099-10-01T00:00:00+08:00' },
      })?.promotion?.endsAt,
    ).toBe('2099-09-30T16:00:00.000Z');
  });

  it('drops a campaign that says nothing', () => {
    expect(
      normalize({ id: 'quiet', promotion: { label: '  ' }, tier: {} })
        ?.promotion,
    ).toBeUndefined();
    expect(normalize({ id: 'quiet', tier: {} })?.tier).toBeUndefined();
    expect(
      normalize({ id: 'quiet', promotion: 'x' })?.promotion,
    ).toBeUndefined();
    expect(
      normalize({ id: 'quiet', promotion: [] })?.promotion,
    ).toBeUndefined();
  });

  it('survives being applied to its own output', () => {
    const once = normalize({
      capabilityTags: ['craft'],
      contextLengths: [200000],
      credits: 'x3.33',
      id: 'round-trip',
      promotion: {
        discountedCredits: 'x0.00',
        endsAt: '2099-10-01T00:00:00.000Z',
        label: '限时免费',
        textZh: '限时免费',
      },
      relatedModels: { lite: 'round-trip-lite' },
      supportedEfforts: ['high'],
      tier: { label: '旗舰版', level: 'flagship' },
      vendor: 'e',
    });

    // A cached catalog is a normalised model, so the normalizer has to accept
    // its own output: the cast is the record shape it was written with.
    expect(normalize(once as unknown as Record<string, unknown>)).toStrictEqual(
      once,
    );
  });
});

describe('pruneInactivePromotions', () => {
  const at = '2026-09-21T00:00:00.000Z';
  const now = Date.parse(at);

  it('hides a campaign that has not opened yet', () => {
    const [model] = pruneInactivePromotions(
      [
        normalizeModelFields({
          id: 'pending',
          promotion: { label: '未开始', startsAt: '2026-09-22T00:00:00.000Z' },
        })!,
      ],
      now,
    );

    expect(model?.promotion).toBeUndefined();
    // The model itself is untouched: only the offer is withheld.
    expect(model?.id).toBe('pending');
  });

  it('shows the same campaign once its window opens', () => {
    const model = normalizeModelFields({
      id: 'pending',
      promotion: { label: '未开始', startsAt: '2026-09-22T00:00:00.000Z' },
    });

    expect(
      pruneInactivePromotions([model!], now)[0]?.promotion,
    ).toBeUndefined();
    expect(
      pruneInactivePromotions(
        [model!],
        Date.parse('2026-09-22T00:00:00.000Z'),
      )[0]?.promotion?.label,
    ).toBe('未开始');
  });

  it('stops showing a campaign after its window closes', () => {
    const [model] = pruneInactivePromotions(
      [
        normalizeModelFields({
          id: 'over',
          promotion: { endsAt: '2026-09-20T00:00:00.000Z', label: '已结束' },
        })!,
      ],
      now,
    );

    expect(model?.promotion).toBeUndefined();
  });

  it('keeps a promotion whose window is open', () => {
    // Both bounds sit far from today: `normalizeModelFields` reads the real
    // clock, so a window dated anywhere near it turns this into a time bomb.
    const model = normalizeModelFields({
      id: 'running',
      promotion: {
        endsAt: '2099-01-01T00:00:00.000Z',
        label: '进行中',
        startsAt: '2020-01-01T00:00:00.000Z',
      },
    })!;

    expect(pruneInactivePromotions([model], now)[0]?.promotion?.label).toBe(
      '进行中',
    );
  });

  it('stops showing a campaign whose window closed while cached', () => {
    // The normalizer drops an ended campaign on the way in, but a catalog can
    // also be handed over already holding one — by a clock that moved, or by a
    // hand-edited cache — so the pruner checks the window for itself.
    const [model] = pruneInactivePromotions(
      [
        {
          displayName: 'Over',
          id: 'over',
          promotion: {
            endsAt: '2026-09-20T00:00:00.000Z',
            label: '已结束',
          },
        },
      ],
      now,
    );

    expect(model?.promotion).toBeUndefined();
  });

  it('leaves a model without a promotion alone', () => {
    const models = [normalizeModelFields({ id: 'plain' })!];

    expect(pruneInactivePromotions(models, now)).toStrictEqual(models);
  });
});
