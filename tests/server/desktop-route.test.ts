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

const rawRequest = (body: string): Request =>
  new Request('http://localhost/admin-api/desktop', {
    body,
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
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
    vi.mocked(getAdminSessionErrorResponse).mockResolvedValue(null);

    fs.rmSync(root, { force: true, recursive: true });
    delete process.env.CODEBUDDY_DESKTOP;
    delete process.env.CODEBUDDY_DESKTOP_USER_DATA_DIR;
    delete process.env.PORT;
  });

  afterAll(() => {
    fs.rmSync(root, { force: true, recursive: true });
  });

  describe('an unauthenticated caller', () => {
    beforeEach(() => {
      vi.mocked(getAdminSessionErrorResponse).mockResolvedValue(
        Response.json({ error: { message: 'Sign in' } }, { status: 401 }),
      );
    });

    it('is refused by GET', async () => {
      enterDesktopMode();

      const response = await GET(request());

      expect(response.status).toBe(401);
    });

    it('is refused by POST without touching the settings', async () => {
      enterDesktopMode();

      const response = await POST(request({ port: 8123 }));

      expect(response.status).toBe(401);
      expect(fs.existsSync(desktopSettingsPath(userDataDir))).toBe(false);
    });
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

    it('reports the saved port when the gateway port is unknown', async () => {
      enterDesktopMode();
      delete process.env.PORT;
      fs.writeFileSync(
        desktopSettingsPath(userDataDir),
        JSON.stringify({ port: 8123 }),
      );

      const payload = await asPayload(await GET(request()));

      expect(payload.port).toBe(8123);
    });

    it('is not desktop outside the app', async () => {
      const payload = await asPayload(await GET(request()));

      expect(payload).toEqual({
        desktop: false,
        port: 0,
        preferredPort: 0,
        storageBackend: 'sqlite',
      });
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

    it('saves the port into the trimmed user data directory', async () => {
      enterDesktopMode();
      process.env.CODEBUDDY_DESKTOP_USER_DATA_DIR = `  ${userDataDir}  `;

      await POST(request({ port: 8123 }));

      expect(fs.existsSync(desktopSettingsPath(userDataDir))).toBe(true);
    });

    it.each([{ port: 'nope' }, { port: 0 }, { port: 70_000 }, {}])(
      'rejects an unusable port %j',
      async (body) => {
        enterDesktopMode();

        const response = await POST(request(body));

        expect(response.status).toBe(400);
        expect((await asPayload(response)).error?.message).toBe(
          'Port must be a number between 1024 and 65535',
        );
        expect(fs.existsSync(desktopSettingsPath(userDataDir))).toBe(false);
      },
    );

    it('reports a settings file it cannot write', async () => {
      const blocker = path.join(root, 'not-a-directory');
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(blocker, '');
      process.env.CODEBUDDY_DESKTOP = '1';
      process.env.CODEBUDDY_DESKTOP_USER_DATA_DIR = blocker;
      process.env.PORT = '8001';

      const response = await POST(request({ port: 8123 }));

      expect(response.status).toBe(500);
      expect((await asPayload(response)).error?.message).toContain(
        'Could not save',
      );
    });

    it.each([
      { body: 'not json', why: 'malformed JSON' },
      { body: '', why: 'an empty body' },
    ])('rejects $why', async ({ body }) => {
      enterDesktopMode();

      const response = await POST(rawRequest(body));

      expect(response.status).toBe(400);
      expect((await asPayload(response)).error?.message).toBe(
        'Request body must be valid JSON',
      );
      expect(fs.existsSync(desktopSettingsPath(userDataDir))).toBe(false);
    });

    // `[]` and `null` parse fine, so they reach the port check instead.
    it.each([
      { body: '[]', why: 'a non-object body' },
      { body: 'null', why: 'a null body' },
    ])('rejects $why', async ({ body }) => {
      enterDesktopMode();

      const response = await POST(rawRequest(body));

      expect(response.status).toBe(400);
      expect((await asPayload(response)).error?.message).toBe(
        'Port must be a number between 1024 and 65535',
      );
      expect(fs.existsSync(desktopSettingsPath(userDataDir))).toBe(false);
    });

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
