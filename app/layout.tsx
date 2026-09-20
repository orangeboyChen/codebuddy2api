import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { AntdRegistry } from '@ant-design/nextjs-registry';
import { NextIntlClientProvider } from 'next-intl';
import { cookies, headers } from 'next/headers';

import './globals.scss';
import LobeUiProvider from '@/app/lobe-ui-provider';
import LobeStyleRegistry from '@/app/lobe-style-registry';
import PwaRegistrar from '@/app/pwa-registrar';
import {
  parseThemeMode,
  resolveThemeMode,
  resolvedThemeCookieName,
  themeCookieName,
} from '@/lib/theme';
import {
  localeCookieName,
  localePreferenceCookieName,
  parseLocalePreference,
  resolveAppLocale,
  systemLocalePreference,
} from '@/lib/i18n/routing';
import { getMessages } from '@/lib/i18n/messages';

export const metadata: Metadata = {
  title: 'CodeBuddy2API',
  description: 'Next.js admin shell for the CodeBuddy2API migration.',
  applicationName: 'CodeBuddy2API',
  appleWebApp: {
    capable: true,
    title: 'CodeBuddy2API',
  },
  // Next emits `mobile-web-app-capable` for `appleWebApp.capable`; the Apple
  // spelling is what an iOS that cannot read the manifest falls back to.
  other: { 'apple-mobile-web-app-capable': 'yes' },
};

/**
 * Installed shortcuts paint their own window chrome from this, so it follows
 * the OS theme rather than the colour the console happens to have loaded in.
 */
export const viewport: Viewport = {
  themeColor: [
    { color: '#FFFFFF', media: '(prefers-color-scheme: light)' },
    { color: '#191A23', media: '(prefers-color-scheme: dark)' },
  ],
  width: 'device-width',
  initialScale: 1,
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
  const themePreference = parseThemeMode(
    cookieStore.get(themeCookieName)?.value,
  );
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
            <LobeUiProvider initialTheme={themePreference}>
              <NextIntlClientProvider locale={locale} messages={messages}>
                {children}
              </NextIntlClientProvider>
            </LobeUiProvider>
          </LobeStyleRegistry>
        </AntdRegistry>
        <PwaRegistrar />
      </body>
    </html>
  );
};

export default RootLayout;
