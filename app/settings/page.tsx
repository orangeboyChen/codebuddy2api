import { AdminPage } from '@/app/page';

import Settings from './settings';

const SettingsPage = async () => {
  return (
    <AdminPage initialTab="settings">
      <Settings />
    </AdminPage>
  );
};

export default SettingsPage;
