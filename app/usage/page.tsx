import { AdminPage } from '@/app/page';

import Usage from './usage';

const UsagePage = async () => {
  return (
    <AdminPage initialTab="usage">
      <Usage />
    </AdminPage>
  );
};

export default UsagePage;
