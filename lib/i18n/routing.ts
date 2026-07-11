import { defineRouting } from 'next-intl/routing';

export const locales = ['zh-CN', 'en-US', 'ja-JP'] as const;

export type AppLocale = (typeof locales)[number];

export const defaultLocale: AppLocale = 'zh-CN';

export const localeCookieName = 'codebuddy2api-locale';

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
