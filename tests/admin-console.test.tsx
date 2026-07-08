// @vitest-environment jsdom

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import AdminConsole from '@/app/admin/_components/admin-console';

const makeJsonResponse = (payload: Record<string, unknown>, status = 200) => {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
};

describe('AdminConsole', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        clear: vi.fn(),
        getItem: vi.fn(() => null),
        removeItem: vi.fn(),
        setItem: vi.fn(),
      },
      writable: true,
    });

    Object.defineProperty(window, 'open', {
      configurable: true,
      value: vi.fn(),
      writable: true,
    });

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });

    globalThis.fetch = vi.fn(async (input) => {
      if (input === '/health') {
        return makeJsonResponse({ status: 'healthy' });
      }

      if (input === '/admin-api/credentials') {
        return makeJsonResponse({ credentials: [] });
      }

      if (input === '/admin-api/credentials/current') {
        return makeJsonResponse({ status: 'no_credentials' });
      }

      if (input === '/admin-api/stats') {
        return makeJsonResponse({
          credential_usage: {},
          model_usage: {},
        });
      }

      if (input === '/codebuddy/auth/start') {
        return makeJsonResponse({
          auth_state: 'state-1',
          verification_uri_complete: 'https://example.com/device',
        });
      }

      if (
        input === '/codebuddy/auth/poll' ||
        (input instanceof Request && input.url.endsWith('/codebuddy/auth/poll'))
      ) {
        return makeJsonResponse({ error: 'authorization_pending' });
      }

      return makeJsonResponse({});
    }) as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps delegated clicks working for auth start', async () => {
    render(<AdminConsole />);

    await waitFor(() => {
      expect(document.getElementById('totalCredentials')?.textContent).toBe(
        '0',
      );
      expect(document.getElementById('validCredentials')?.textContent).toBe(
        '0',
      );
    });

    fireEvent.click(screen.getByText('凭证管理'));
    fireEvent.click(screen.getByText('开始认证'));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalled();
      expect(
        vi.mocked(globalThis.fetch).mock.calls.some(([input]) => {
          return input === '/codebuddy/auth/start';
        }),
      ).toBe(true);
    });

    await waitFor(() => {
      expect(
        (document.getElementById('authUrlInput') as HTMLInputElement).value,
      ).toBe('https://example.com/device');
      expect(
        document.getElementById('authUrlSection')?.classList.contains('hidden'),
      ).toBe(false);
    });
  });
});
