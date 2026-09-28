import { headers } from 'next/headers';
import { cookies } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';

import DeviceClient from './device-client';
import { getAdminSessionSummary } from '@/lib/server/admin/session';
import { getMessages } from '@/lib/i18n/messages';
import { resolveRequestOrigin } from '@/lib/server/shared/http';
import {
  localeCookieName,
  localePreferenceCookieName,
  parseLocalePreference,
  resolveAppLocale,
  systemLocalePreference,
} from '@/lib/i18n/routing';
import { parseThemeMode, themeCookieName } from '@/lib/theme';

export const dynamic = 'force-dynamic';

/**
 * Where a device's sign-in is approved.
 *
 * The desktop app opens this page in the browser and shows the code in a dialog:
 * the sign-in it sits behind is this console's own, on the address the user's
 * passkey and saved passwords belong to — which is exactly what the app's window
 * at `127.0.0.1` cannot offer them.
 */
const DevicePage = async ({
  searchParams,
}: {
  searchParams: Promise<{ user_code?: string }>;
}) => {
  const headerStore = await headers();
  const cookieStore = await cookies();
  const { user_code: userCode } = await searchParams;
  const localePreference = parseLocalePreference(
    cookieStore.get(localePreferenceCookieName)?.value ??
      cookieStore.get(localeCookieName)?.value,
  );
  const locale = resolveAppLocale(
    localePreference === systemLocalePreference
      ? (headerStore.get('accept-language') ?? undefined)
      : localePreference,
  );
  const { protocol, host } = await resolveRequestOrigin(headerStore, {
    host: 'localhost',
    protocol: 'http',
  });
  const cookieHeader = headerStore.get('cookie') ?? '';
  const request = new Request(`${protocol}://${host}/device`, {
    headers: cookieHeader ? { cookie: cookieHeader } : {},
  });
  const session = await getAdminSessionSummary(request);
  await getTranslations({
    locale,
    namespace: 'Admin.devicePage',
  });
  const messages = getMessages(locale);

  // Approving is saying the device is yours, which is a thing only the admin can
  // say: they sign in first and are brought back here, code and all.
  if (!session.authenticated) {
    redirect(
      `/login?next=${encodeURIComponent(
        `/device${userCode ? `?user_code=${encodeURIComponent(userCode)}` : ''}`,
      )}`,
    );
  }

  return (
    <DeviceClient
      initialTheme={parseThemeMode(cookieStore.get(themeCookieName)?.value)}
      initialUserCode={userCode ?? ''}
      locale={locale}
      localePreference={localePreference}
      translations={messages.Admin.devicePage}
    />
  );
};

export default DevicePage;
