import { AdminPage } from '@/app/page';
import { resolveAdminUpstream } from '@/lib/server/admin/upstream';
import { isDesktopMode } from '@/lib/server/electron/settings';

import Settings from './settings';

const SettingsPage = async () => {
  // Whose sign-in these settings are for. A desktop install keeping its own
  // data on this machine has none to set, but one showing a deployment is that
  // deployment's console, and a deployment is reachable from a network — so the
  // password, and the passkeys, are still something the user has to manage.
  const upstream = resolveAdminUpstream();

  return (
    <AdminPage initialTab="settings">
      <Settings
        deploymentUrl={upstream ?? undefined}
        desktop={isDesktopMode() && !upstream}
      />
    </AdminPage>
  );
};

export default SettingsPage;
