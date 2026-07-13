import { POST } from '@/app/admin-api/preferences/route';

const createRequest = (protocol: 'http' | 'https'): Request => {
  return new Request(`${protocol}://127.0.0.1:8001/admin-api/preferences`, {
    body: JSON.stringify({ localePreference: 'en-US' }),
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-proto': protocol,
    },
    method: 'POST',
  });
};

describe('admin preference cookies', () => {
  it('keeps HTTP preference cookies available to the documented local server', async () => {
    const response = await POST(createRequest('http'));
    const cookie = response.headers.get('set-cookie') ?? '';

    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=lax');
    expect(cookie).not.toContain('Secure');
  });

  it('marks HTTPS preference cookies as secure', async () => {
    const response = await POST(createRequest('https'));

    expect(response.headers.get('set-cookie')).toContain('Secure');
  });
});
