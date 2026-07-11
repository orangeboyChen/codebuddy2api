import { getRequestConfig } from 'next-intl/server';
import { cookies } from 'next/headers';

import { defaultLocale, locales } from '@/lib/i18n/routing';

const loadMessages = async (locale: (typeof locales)[number]) => {
  return (await import(`@/messages/${locale}.json`)).default;
};

export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const requestedLocale = cookieStore.get('codebuddy2api-locale')?.value;
  const locale = locales.includes(requestedLocale as (typeof locales)[number])
    ? (requestedLocale as (typeof locales)[number])
    : defaultLocale;

  return {
    locale,
    messages: await loadMessages(locale),
    timeZone: 'Asia/Shanghai',
  };
});
