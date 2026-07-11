import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import { cookies, headers } from 'next/headers';

import '@fortawesome/fontawesome-free/css/all.min.css';
import './globals.scss';
import { resolveThemeMode, resolvedThemeCookieName } from '@/lib/theme';
import {
  defaultLocale,
  localeCookieName,
  locales,
  type AppLocale,
} from '@/lib/i18n/routing';
import { getMessages } from '@/lib/i18n/messages';

export const metadata: Metadata = {
  title: 'CodeBuddy2API Console',
  description: 'Next.js admin shell for the CodeBuddy2API migration.',
};

const resolveLocale = (value: string | undefined): AppLocale => {
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

const RootLayout = async ({
  children,
}: Readonly<{
  children: ReactNode;
}>) => {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  const requestedLocale = cookieStore.get(localeCookieName)?.value;
  const locale = resolveLocale(
    requestedLocale ?? headerStore.get('accept-language') ?? undefined,
  );
  const messages = getMessages(locale);
  const theme = resolveThemeMode(
    cookieStore.get(resolvedThemeCookieName)?.value,
  );

  return (
    <html
      className={theme === 'dark' ? 'dark' : undefined}
      lang={locale}
      // eslint-disable-next-line react/forbid-dom-props
      style={{ colorScheme: theme }}
    >
      <body>
        <NextIntlClientProvider locale={locale} messages={messages}>
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
};

export default RootLayout;
