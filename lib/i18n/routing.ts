import { defineRouting } from 'next-intl/routing';

export const locales = ['zh-CN', 'en-US', 'ja-JP'] as const;

export type AppLocale = (typeof locales)[number];

export const defaultLocale: AppLocale = 'zh-CN';

export const localeCookieName = 'codebuddy2api-locale';
export const localePreferenceCookieName = 'codebuddy2api-locale-preference';
export const systemLocalePreference = 'system' as const;

export type LocalePreference = AppLocale | typeof systemLocalePreference;

export const parseLocalePreference = (
  value: string | undefined,
): LocalePreference => {
  if (locales.includes(value as AppLocale)) {
    return value as AppLocale;
  }

  return systemLocalePreference;
};

export const resolveAppLocale = (value: string | undefined): AppLocale => {
  if (locales.includes(value as AppLocale)) {
    return value as AppLocale;
  }

  const acceptedLanguages = value?.split(',') ?? [];

  for (const entry of acceptedLanguages) {
    const language = entry.split(';')[0]?.trim();

    if (language === 'ja' || language === 'ja-JP') {
      return 'ja-JP';
    }

    if (language === 'en' || language === 'en-US') {
      return 'en-US';
    }

    if (language === 'zh' || language === 'zh-CN') {
      return 'zh-CN';
    }
  }

  return defaultLocale;
};

export const routing = defineRouting({
  defaultLocale,
  localeCookie: {
    maxAge: 60 * 60 * 24 * 365,
    name: localeCookieName,
    sameSite: 'lax',
  },
  localeDetection: true,
  localePrefix: 'never',
  locales,
});
