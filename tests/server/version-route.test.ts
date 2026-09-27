import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import packageJson from '@/package.json';

vi.mock('@/lib/server/admin/session', () => ({
  getAdminSessionErrorResponse: vi.fn(),
}));

const { getAdminSessionErrorResponse } =
  await import('@/lib/server/admin/session');
const { GET } = await import('@/app/admin-api/version/route');

const request = (): Request =>
  new Request('http://localhost/admin-api/version');

describe('version admin route', () => {
  beforeEach(() => {
    vi.mocked(getAdminSessionErrorResponse).mockResolvedValue(null);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('names the build serving the console', async () => {
    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ version: packageJson.version });
  });

  it('is refused without a session', async () => {
    vi.mocked(getAdminSessionErrorResponse).mockResolvedValue(
      Response.json({ error: { message: 'Sign in' } }, { status: 401 }),
    );

    const response = await GET(request());

    expect(response.status).toBe(401);
  });
});
