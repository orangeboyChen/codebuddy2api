import { createNavigation } from 'next-intl/navigation';

import { routing } from '@/lib/i18n/routing';

export const { Link, getPathname, redirect, usePathname, useRouter } =
  createNavigation(routing);
