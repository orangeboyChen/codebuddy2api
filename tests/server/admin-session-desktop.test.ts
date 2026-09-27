import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getAdminSessionErrorResponse,
  getAdminSessionSummary,
  isAdminSessionAuthenticated,
  setupAdminPassword,
} from '@/lib/server/admin/session';

const request = () => new Request('http://127.0.0.1:8001/dashboard');

const enterDesktopMode = (): void => {
  vi.stubEnv('CODEBUDDY_DESKTOP', '1');
};

describe('admin authentication in the desktop app', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('lets every admin request through without a session', async () => {
    enterDesktopMode();

    await expect(getAdminSessionErrorResponse(request())).resolves.toBeNull();
  });

  it('counts as signed in', async () => {
    enterDesktopMode();

    await expect(isAdminSessionAuthenticated(request())).resolves.toBe(true);
  });

  it('reports an open session with nothing to configure', async () => {
    enterDesktopMode();

    await expect(getAdminSessionSummary(request())).resolves.toEqual({
      accountConfigured: false,
      authEnabled: false,
      authenticated: true,
      passkeyCount: 0,
      passwordConfigured: false,
      usagePreferences: null,
      username: 'admin',
    });
  });

  it('has no admin account to set up', async () => {
    enterDesktopMode();

    const response = await setupAdminPassword(
      request(),
      'admin',
      'a-long-enough-password',
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { message: 'Admin authentication is not used in the desktop app' },
    });
  });
});
