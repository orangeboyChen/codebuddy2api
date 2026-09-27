import fs from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/server/admin/session', () => ({
  getAdminSessionErrorResponse: vi.fn(),
}));

const { getAdminSessionErrorResponse } =
  await import('@/lib/server/admin/session');
const { GET, POST } = await import('@/app/admin-api/desktop/route');
const { desktopSettingsPath } = await import('@/lib/server/electron/settings');

const root = path.join(process.cwd(), '.tmp-test-desktop-route');
const userDataDir = path.join(root, 'user-data');

const request = (body?: unknown): Request =>
  new Request('http://localhost/admin-api/desktop', {
    ...(body === undefined
      ? {}
      : {
          body: JSON.stringify(body),
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
        }),
  });

const asPayload = async (response: Response) =>
  (await response.json()) as {
    desktop: boolean;
    error?: { message?: string };
    port: number;
    preferredPort: number;
    restarting?: boolean;
    storageBackend: string;
  };

const enterDesktopMode = (): void => {
  fs.mkdirSync(userDataDir, { recursive: true });
  process.env.CODEBUDDY_DESKTOP = '1';
  process.env.CODEBUDDY_DESKTOP_USER_DATA_DIR = userDataDir;
  process.env.PORT = '8001';
};

describe('desktop admin route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAdminSessionErrorResponse).mockResolvedValue(null);

    fs.rmSync(root, { force: true, recursive: true });
    delete process.env.CODEBUDDY_DESKTOP;
    delete process.env.CODEBUDDY_DESKTOP_USER_DATA_DIR;
    delete process.env.PORT;
  });

  describe('GET', () => {
    it('reports the running port and the fixed backend', async () => {
      enterDesktopMode();

      const payload = await asPayload(await GET(request()));

      expect(payload).toEqual({
        desktop: true,
        port: 8001,
        preferredPort: 8001,
        storageBackend: 'sqlite',
      });
    });

    it('reports the saved port when it differs from the running one', async () => {
      enterDesktopMode();
      fs.writeFileSync(
        desktopSettingsPath(userDataDir),
        JSON.stringify({ port: 8123 }),
      );

      const payload = await asPayload(await GET(request()));

      expect(payload.port).toBe(8001);
      expect(payload.preferredPort).toBe(8123);
    });

    it('is not desktop outside the app', async () => {
      const payload = await asPayload(await GET(request()));

      expect(payload.desktop).toBe(false);
    });
  });

  describe('POST', () => {
    it('saves the port and reports the restart', async () => {
      enterDesktopMode();

      const payload = await asPayload(await POST(request({ port: '8123' })));

      expect(payload.restarting).toBe(true);
      expect(payload.preferredPort).toBe(8123);
      expect(
        JSON.parse(fs.readFileSync(desktopSettingsPath(userDataDir), 'utf8')),
      ).toEqual({ port: 8123 });
    });

    it.each([{ port: 'nope' }, { port: 0 }, { port: 70_000 }, {}])(
      'rejects an unusable port %j',
      async (body) => {
        enterDesktopMode();

        const response = await POST(request(body));

        expect(response.status).toBe(400);
        expect(fs.existsSync(desktopSettingsPath(userDataDir))).toBe(false);
      },
    );

    it('is unavailable outside the desktop app', async () => {
      process.env.PORT = '8001';

      const response = await POST(request({ port: 8123 }));

      expect(response.status).toBe(404);
    });

    it('is unavailable without a user data directory', async () => {
      process.env.CODEBUDDY_DESKTOP = '1';
      process.env.PORT = '8001';

      const response = await POST(request({ port: 8123 }));

      expect(response.status).toBe(404);
    });
  });
});
