import { AdminPage } from '@/app/page';
import {
  getAccountStatus,
  getAccountStatusCredentials,
} from '@/lib/server/domain/account-status';
import AccountStatus from './account-status';

const AccountStatusPage = async () => {
  const [credentials, statuses] = await Promise.all([
    getAccountStatusCredentials(),
    getAccountStatus(),
  ]);

  return (
    <AdminPage initialTab="account-status">
      <AccountStatus
        credentials={credentials as never}
        initialStatuses={statuses}
      />
    </AdminPage>
  );
};

export default AccountStatusPage;
