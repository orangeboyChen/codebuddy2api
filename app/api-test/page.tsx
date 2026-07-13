import { AdminPage } from '@/app/page';

import ApiTest from './api-test';

const ApiTestPage = async () => {
  return (
    <AdminPage initialTab="api-test">
      <ApiTest />
    </AdminPage>
  );
};

export default ApiTestPage;
