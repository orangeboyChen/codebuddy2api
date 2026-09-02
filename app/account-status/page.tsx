import { AdminPage } from '@/app/page';
import { getAccountStatusCredentials } from '@/lib/server/domain/account-status';
import AccountStatus from './account-status';

const AccountStatusPage = async () => {
  const credentials = await getAccountStatusCredentials();

  return (
    <AdminPage initialTab="account-status">
      <AccountStatus credentials={credentials as never} />
    </AdminPage>
  );
};

export default AccountStatusPage;
