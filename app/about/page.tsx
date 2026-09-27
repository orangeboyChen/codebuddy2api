import { cookies } from 'next/headers';

import { AdminPage } from '@/app/page';
import {
  DESKTOP_VERSION_COOKIE,
  isDesktopMode,
} from '@/lib/server/electron/settings';
import packageJson from '@/package.json';

import About from './about';

const AboutPage = async () => {
  const cookieStore = await cookies();
  const desktopVersion =
    cookieStore.get(DESKTOP_VERSION_COOKIE)?.value?.trim() ?? '';
  // The desktop app's own gateway is the app, so naming its version twice says
  // nothing: the server version is only worth a row when this console is being
  // served by a deployment of its own.
  const serverVersion = isDesktopMode() ? '' : packageJson.version;

  return (
    <AdminPage initialTab="about">
      <About desktopVersion={desktopVersion} serverVersion={serverVersion} />
    </AdminPage>
  );
};

export default AboutPage;
