'use client';

import { useEffect } from 'react';

import { registerServiceWorker } from '@/lib/client/service-worker';

/**
 * Mounted once from the root layout to register the service worker. It renders
 * nothing; registration is a side effect of the console being loaded.
 */
const PwaRegistrar = () => {
  useEffect(() => {
    void registerServiceWorker();
  }, []);

  return null;
};

export default PwaRegistrar;
