import { headers } from 'next/headers';

import { AdminPage } from '@/app/page';
import {
  fetchUpstreamAccountStatus,
  resolveAdminUpstream,
} from '@/lib/server/admin/upstream';
import {
  getAccountStatus,
  getAccountStatusCredentials,
} from '@/lib/server/domain/account-status';

import AccountStatus, { type AccountStatusSnapshot } from './account-status';

const AccountStatusPage = async () => {
  // Whose accounts these are. This console is always this app's own build, so
  // with a deployment configured the accounts are the deployment's, asked of it
  // — the bundled gateway's own storage has none of them, and reading it would
  // show a remote-backed desktop nothing at all.
  const upstream = resolveAdminUpstream();
  const headerStore = await headers();
  let credentials: unknown[] = [];
  let statuses: unknown[] = [];

  if (upstream) {
    const fromDeployment = await fetchUpstreamAccountStatus({
      cookie: headerStore.get('cookie') ?? '',
      upstream,
    });

    credentials = fromDeployment?.credentials ?? [];
    statuses = fromDeployment?.statuses ?? [];
  } else {
    [credentials, statuses] = await Promise.all([
      getAccountStatusCredentials(),
      getAccountStatus(),
    ]);
  }

  return (
    <AdminPage initialTab="account-status">
      <AccountStatus
        credentials={credentials as never}
        initialStatuses={statuses as AccountStatusSnapshot[]}
      />
    </AdminPage>
  );
};

export default AccountStatusPage;
