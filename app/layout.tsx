import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AntdRegistry } from '@ant-design/nextjs-registry';
import { NextIntlClientProvider } from 'next-intl';
import { cookies, headers } from 'next/headers';

import './globals.scss';
import LobeUiProvider from '@/app/_components/lobe-ui-provider';
import LobeStyleRegistry from '@/app/_components/lobe-style-registry';
import { resolveThemeMode, resolvedThemeCookieName } from '@/lib/theme';
import {
  localeCookieName,
  localePreferenceCookieName,
  parseLocalePreference,
  resolveAppLocale,
  systemLocalePreference,
} from '@/lib/i18n/routing';
import { getMessages } from '@/lib/i18n/messages';

export const metadata: Metadata = {
  title: 'CodeBuddy2API Console',
  description: 'Next.js admin shell for the CodeBuddy2API migration.',
};

const RootLayout = async ({
  children,
}: Readonly<{
  children: ReactNode;
}>) => {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  const localePreference = parseLocalePreference(
    cookieStore.get(localePreferenceCookieName)?.value ??
      cookieStore.get(localeCookieName)?.value,
  );
  const locale = resolveAppLocale(
    localePreference === systemLocalePreference
      ? (headerStore.get('accept-language') ?? undefined)
      : localePreference,
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
        <AntdRegistry>
          <LobeStyleRegistry>
            <LobeUiProvider initialTheme={theme}>
              <NextIntlClientProvider locale={locale} messages={messages}>
                {children}
              </NextIntlClientProvider>
            </LobeUiProvider>
          </LobeStyleRegistry>
        </AntdRegistry>
      </body>
    </html>
  );
};

export default RootLayout;
