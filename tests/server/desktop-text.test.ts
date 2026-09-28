import {
  desktopLocales,
  desktopText,
  formatTokenCount,
  resolveDesktopLocale,
  statusText,
  usageText,
  type DesktopText,
} from '@/lib/server/electron/desktop-text';

const keys = Object.keys(desktopText('en-US')) as Array<keyof DesktopText>;

describe('desktop text', () => {
  it('offers the same strings in every locale', () => {
    for (const locale of desktopLocales()) {
      expect(Object.keys(desktopText(locale)).sort()).toEqual([...keys].sort());
    }
  });

  // A placeholder is an address, not prose — it is meant to look the same
  // everywhere so the field is recognisable.
  const notProse = new Set<keyof DesktopText>(['backendUrlPlaceholder']);

  it('left no English string untranslated', () => {
    const english = desktopText('en-US');

    for (const locale of desktopLocales().filter((it) => it !== 'en-US')) {
      const translated = desktopText(locale);

      for (const key of keys) {
        if (notProse.has(key)) {
          continue;
        }

        if (/^[A-Za-z0-9 .:/_…?·-]+$/.test(english[key])) {
          expect(translated[key], `${locale}.${key}`).not.toBe(english[key]);
        }
      }
    }
  });
});

describe('resolveDesktopLocale', () => {
  it.each([
    { value: 'zh-CN', expected: 'zh-CN' },
    { value: 'en-US', expected: 'en-US' },
    { value: 'ja-JP', expected: 'ja-JP' },
    { value: '  ja-JP  ', expected: 'ja-JP' },
    { value: 'de-DE', expected: 'en-US' },
    { value: '', expected: 'en-US' },
    { value: undefined, expected: 'en-US' },
  ])('maps $value to $expected', ({ value, expected }) => {
    expect(resolveDesktopLocale(value)).toBe(expected);
  });
});

describe('statusText', () => {
  it.each([
    { status: 'running', expected: 'Running · 127.0.0.1:8001' },
    { status: 'starting', expected: 'Starting gateway…' },
    { status: 'failed', expected: 'Gateway failed to start' },
    // The gateway is running; it is the deployment behind it that is not
    // answering, which is a different thing to fix.
    { status: 'unreachable', expected: 'Deployment unreachable' },
    // No gateway at all: the port it would have served on is taken, and the
    // number is what tells the user which one to change.
    { status: 'portBusy', expected: 'Port 8001 in use' },
    // Stopped on purpose, so it is not a failure and not a number to change:
    // the menu bar item says what it is, and offers starting it again.
    { status: 'paused', expected: 'Paused' },
  ] as const)('reads $status in English', ({ status, expected }) => {
    expect(
      statusText(desktopText('en-US'), status, {
        address: '127.0.0.1:8001',
        port: '8001',
      }),
    ).toBe(expected);
  });

  it('does not report a gateway for a remote backend', () => {
    // Only the address: the gateway this app runs is not the one in use.
    expect(
      statusText(desktopText('zh-CN'), 'running', {
        address: 'api.example.com',
        port: '8001',
      }),
    ).toBe('运行中 · api.example.com');
  });
});

describe('formatTokenCount', () => {
  it.each([
    { value: 0, expected: '0' },
    { value: -5, expected: '0' },
    { value: 12, expected: '12' },
    { value: 999, expected: '999' },
    { value: 1_234, expected: '1.2K' },
    { value: 12_345, expected: '12.3K' },
    { value: 1_234_567, expected: '1.2M' },
  ])('compacts $value', ({ value, expected }) => {
    expect(formatTokenCount(value)).toBe(expected);
  });

  it.each([{ value: Number.NaN }, { value: Number.POSITIVE_INFINITY }])(
    'refuses $value',
    ({ value }) => {
      expect(formatTokenCount(value)).toBe('0');
    },
  );

  it('follows the locale it is given', () => {
    // 万, not K: the shell counts in the language the console is showing.
    expect(formatTokenCount(1_234_567, 'zh-CN')).toBe('123.5万');
  });
});

describe('usageText', () => {
  it('fills both counts in', () => {
    expect(
      usageText(desktopText('zh-CN'), { input: 1_234, output: 5_678 }),
    ).toBe('今日消耗 1.2K / 5.7K');
  });

  it.each([{ usage: null, why: 'no usage' }])(
    'says so when there is $why',
    ({ usage }) => {
      expect(usageText(desktopText('en-US'), usage)).toBe('Usage unavailable');
    },
  );
});
