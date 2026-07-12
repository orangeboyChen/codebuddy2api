import { notFound } from 'next/navigation';

import { renderAdminConsole } from '@/app/page';
import { isTabKey } from '@/app/admin/_components/admin-store';

interface TabPageProps {
  params: Promise<{ tab: string }>;
}

const TabPage = async ({ params }: TabPageProps) => {
  const { tab } = await params;

  if (!isTabKey(tab)) {
    notFound();
  }

  return renderAdminConsole(tab);
};

export default TabPage;
