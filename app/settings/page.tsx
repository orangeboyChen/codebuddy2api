import { AdminPage } from '@/app/page';
import { isDesktopMode } from '@/lib/server/electron/settings';

import Settings from './settings';

const SettingsPage = async () => {
  return (
    <AdminPage initialTab="settings">
      <Settings desktop={isDesktopMode()} />
    </AdminPage>
  );
};

export default SettingsPage;
