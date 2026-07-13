import { AdminPage } from '@/app/page';

import Dashboard from './dashboard';

const DashboardPage = async () => {
  return (
    <AdminPage initialTab="dashboard">
      <Dashboard />
    </AdminPage>
  );
};

export default DashboardPage;
