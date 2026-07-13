import createNextIntlPlugin from 'next-intl/plugin';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingIncludes: {
    '/*': ['./lib/server/storage/migrations/**'],
  },
  typedRoutes: true,
};

const withNextIntl = createNextIntlPlugin('./lib/i18n/request.ts');

export default withNextIntl(nextConfig);
