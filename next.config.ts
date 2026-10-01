import createNextIntlPlugin from 'next-intl/plugin';
import type { NextConfig } from 'next';

const desktopDevelopment = process.env.CODEBUDDY_DESKTOP_DEV?.trim() === '1';

const nextConfig: NextConfig = {
  ...(desktopDevelopment ? { distDir: '.next-desktop' } : {}),
  output: 'standalone',
  outputFileTracingIncludes: {
    '/*': ['./lib/server/storage/migrations/**'],
  },
  typedRoutes: true,
  headers: async () => [
    {
      source: '/sw.js',
      headers: [
        {
          key: 'Content-Type',
          value: 'application/javascript; charset=utf-8',
        },
        // A cached worker would keep serving the previous console shell after
        // a redeploy, so the browser has to revalidate it on every load.
        {
          key: 'Cache-Control',
          value: 'no-cache, no-store, must-revalidate',
        },
        {
          key: 'Content-Security-Policy',
          value: "default-src 'self'; script-src 'self'",
        },
      ],
    },
  ],
};

const withNextIntl = createNextIntlPlugin('./lib/i18n/request.ts');

export default withNextIntl(nextConfig);
