import type { MetadataRoute } from 'next';

/**
 * Install metadata for the admin console.
 *
 * The console is a tool operators keep open all day, so it advertises itself
 * as a standalone app: browsers offer to install it, and the installed icon
 * opens straight into the dashboard instead of the landing page.
 */
const manifest = (): MetadataRoute.Manifest => {
  return {
    background_color: '#191A23',
    description: 'Admin console for the CodeBuddy2API gateway.',
    display: 'standalone',
    icons: [
      {
        src: '/icons/pwa-192.png',
        sizes: '192x192',
        type: 'image/png',
      },
      {
        src: '/icons/pwa-512.png',
        sizes: '512x512',
        type: 'image/png',
      },
      {
        src: '/icons/pwa-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
    id: '/',
    name: 'CodeBuddy2API',
    scope: '/',
    short_name: 'CB2API',
    start_url: '/dashboard',
    theme_color: '#191A23',
  };
};

export default manifest;
