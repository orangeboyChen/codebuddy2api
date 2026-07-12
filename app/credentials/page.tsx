import { AdminPage } from '@/app/page';

import Credentials from './credentials';

const CredentialsPage = async () => {
  return (
    <AdminPage initialTab="credentials">
      <Credentials />
    </AdminPage>
  );
};

export default CredentialsPage;
