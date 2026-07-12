import { AdminPage } from '@/app/page';

import Debug from './debug';

const DebugPage = async () => {
  return (
    <AdminPage initialTab="debug">
      <Debug />
    </AdminPage>
  );
};

export default DebugPage;
