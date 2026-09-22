// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConfigProvider } from '@lobehub/ui';
import { Provider } from 'jotai';
import { NextIntlClientProvider } from 'next-intl';

import LoginClient from '@/app/login/login-client';
import type { AdminLoginMessages } from '@/lib/i18n/messages';
import type { ThemeMode } from '@/lib/theme';
import { getMessages } from '@/lib/i18n/messages';
import { configProviderMotion } from '@/lib/client/motion';

vi.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthnAutofill: vi.fn(),
  startAuthentication: vi.fn(),
}));

const { browserSupportsWebAuthnAutofill, startAuthentication } =
  await import('@simplewebauthn/browser');

const makeJsonResponse = (payload: unknown, status = 200) => {
  return new Response(JSON.stringify(payload), {
    headers: {
      'Content-Type': 'application/json',
    },
    status,
  });
};

const renderWithMessages = (children: React.ReactNode) => {
  return render(
    <ConfigProvider motion={configProviderMotion}>
      <NextIntlClientProvider locale="zh-CN" messages={getMessages('zh-CN')}>
        {children}
      </NextIntlClientProvider>
    </ConfigProvider>,
  );
};

const loginTranslations: AdminLoginMessages = {
  autofillAvailable: 'Passkey autofill is available.',
  autofillUnavailable: 'Passkey autofill is unavailable.',
  continueWithPasskey: 'Continue with passkey',
  continueWithPassword: 'Sign in',
  createAccountRedirecting: 'Admin account created. Redirecting...',
  createPasswordLabel: 'Create admin password',
  createPasswordPlaceholder: 'Choose a strong password',
  createPasswordStatus:
    'Create the first admin password to unlock the console.',
  createPasswordSubmit: 'Create password',
  description: 'Sign in with the admin password or a passkey.',
  descriptionLogin: 'Use the existing admin password or a registered passkey.',
  descriptionSetup: 'Create the first admin password.',
  errorPasskeyFailed: 'Passkey sign-in failed.',
  errorPasskeyUnavailable: 'Passkey sign-in is unavailable right now.',
  errorPasswordStatus: 'Use your admin password to continue.',
  headingLogin: 'Sign in to CodeBuddy2API',
  headingSetup: 'Set up the admin account',
  noPasskeysConfigured: 'No passkeys are configured.',
  orLabel: 'or',
  passkeyAccepted: 'Passkey accepted. Redirecting...',
  passkeyHintLogin: 'after the first account is configured.',
  passkeyHintSetup: 'and signs you in immediately.',
  passkeyStatusManual: 'Opening the passkey prompt...',
  passwordAccepted: 'Password accepted. Redirecting...',
  passwordLabel: 'Password',
  passwordSignInHint: 'Use your password or a saved passkey to continue.',
  signInWithPassword: 'Creating the admin account...',
  signingInPassword: 'Signing in with password...',
  title: 'Admin sign in',
  usernameLabel: 'Username',
  waitingForPasskey: 'Waiting for a saved passkey...',
};

const stubColorScheme = (prefersDark: boolean) => {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const mediaQuery = {
    addEventListener: (
      type: string,
      listener: (event: MediaQueryListEvent) => void,
    ) => {
      if (type === 'change') {
        listeners.add(listener);
      }
    },
    matches: prefersDark,
    removeEventListener: (
      type: string,
      listener: (event: MediaQueryListEvent) => void,
    ) => {
      if (type === 'change') {
        listeners.delete(listener);
      }
    },
  };

  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => mediaQuery),
  );

  return {
    setPrefersDark: (next: boolean) => {
      mediaQuery.matches = next;
      listeners.forEach((listener) => {
        listener({ matches: next } as MediaQueryListEvent);
      });
    },
  };
};

const renderLogin = (initialTheme?: ThemeMode) => {
  return render(
    <Provider>
      <ConfigProvider motion={configProviderMotion}>
        <NextIntlClientProvider locale="zh-CN" messages={getMessages('zh-CN')}>
          <LoginClient
            initialSession={{
              accountConfigured: true,
              authenticated: false,
              passkeyCount: 0,
              passwordConfigured: true,
            }}
            initialTheme={initialTheme}
            locale="zh-CN"
            translations={loginTranslations}
          />
        </NextIntlClientProvider>
      </ConfigProvider>
    </Provider>,
  );
};

describe('LoginClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('location', {
      assign: vi.fn(),
    });
  });

  it('creates the first admin password and redirects', async () => {
    vi.mocked(browserSupportsWebAuthnAutofill).mockResolvedValue(false);
    globalThis.fetch = vi.fn(async (input) => {
      if (input === '/admin-api/preferences') {
        return makeJsonResponse({ success: true });
      }

      if (input === '/admin-api/auth/setup') {
        return makeJsonResponse({
          session: {
            accountConfigured: true,
            authenticated: true,
            passkeyCount: 0,
            passwordConfigured: true,
          },
          success: true,
        });
      }

      throw new Error(`Unexpected fetch: ${String(input)}`);
    }) as typeof fetch;

    renderWithMessages(
      <LoginClient
        initialSession={{
          accountConfigured: false,
          authenticated: false,
          passkeyCount: 0,
          passwordConfigured: false,
        }}
        locale="zh-CN"
        translations={loginTranslations}
      />,
    );

    fireEvent.change(screen.getByLabelText('Username'), {
      target: { value: 'admin' },
    });
    fireEvent.change(screen.getByLabelText('Create admin password'), {
      target: { value: 'correct horse battery staple' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create password' }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/admin-api/auth/setup',
        expect.objectContaining({
          method: 'POST',
        }),
      );
      expect(window.location.assign).toHaveBeenCalledWith('/');
    });
  });

  it('logs in with password for an existing account', async () => {
    vi.mocked(browserSupportsWebAuthnAutofill).mockResolvedValue(false);
    globalThis.fetch = vi.fn(async (input) => {
      if (input === '/admin-api/preferences') {
        return makeJsonResponse({ success: true });
      }

      if (input === '/admin-api/auth/session') {
        return makeJsonResponse({
          session: {
            accountConfigured: true,
            authenticated: true,
            passkeyCount: 1,
            passwordConfigured: true,
          },
          success: true,
        });
      }

      throw new Error(`Unexpected fetch: ${String(input)}`);
    }) as typeof fetch;

    renderWithMessages(
      <LoginClient
        initialSession={{
          accountConfigured: true,
          authenticated: false,
          passkeyCount: 1,
          passwordConfigured: true,
        }}
        locale="zh-CN"
        translations={loginTranslations}
      />,
    );

    fireEvent.change(screen.getByLabelText('Username'), {
      target: { value: 'admin' },
    });
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'secret-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/admin-api/auth/session',
        expect.objectContaining({
          method: 'POST',
        }),
      );
      expect(window.location.assign).toHaveBeenCalledWith('/');
    });
  });

  it('auto-attempts passkey sign-in when autofill is supported and passkeys exist', async () => {
    vi.mocked(browserSupportsWebAuthnAutofill).mockResolvedValue(true);
    vi.mocked(startAuthentication).mockResolvedValue({
      id: 'passkey-1',
      rawId: 'passkey-1',
      response: {
        authenticatorData: 'auth-data',
        clientDataJSON: 'client-data',
        signature: 'signature',
      },
      type: 'public-key',
    } as Awaited<ReturnType<typeof startAuthentication>>);

    globalThis.fetch = vi.fn(async (input) => {
      if (input === '/admin-api/preferences') {
        return makeJsonResponse({ success: true });
      }

      if (input === '/admin-api/auth/passkeys/authentication/options') {
        return makeJsonResponse({
          options: {
            allowCredentials: [],
            challenge: 'challenge-1',
            rpId: 'localhost',
            timeout: 60_000,
            userVerification: 'preferred',
          },
        });
      }

      if (input === '/admin-api/auth/passkeys/authentication/verify') {
        return makeJsonResponse({
          session: {
            accountConfigured: true,
            authenticated: true,
            passkeyCount: 1,
            passwordConfigured: true,
          },
          success: true,
        });
      }

      throw new Error(`Unexpected fetch: ${String(input)}`);
    }) as typeof fetch;

    renderWithMessages(
      <LoginClient
        initialSession={{
          accountConfigured: true,
          authenticated: false,
          passkeyCount: 1,
          passwordConfigured: true,
        }}
        locale="zh-CN"
        translations={loginTranslations}
      />,
    );

    await waitFor(() => {
      expect(startAuthentication).toHaveBeenCalledWith(
        expect.objectContaining({
          useBrowserAutofill: true,
          verifyBrowserAutofillInput: false,
        }),
      );
      expect(window.location.assign).toHaveBeenCalledWith('/');
    });
  });

  describe('theme parity with the console', () => {
    const originalMatchMedia = window.matchMedia;

    afterEach(() => {
      vi.stubGlobal('matchMedia', originalMatchMedia);
      document.documentElement.classList.remove('dark');
      document.body.classList.remove('dark');
      document.documentElement.style.colorScheme = '';
    });

    it('resolves the system theme on mount instead of trusting the stale cookie', async () => {
      vi.mocked(browserSupportsWebAuthnAutofill).mockResolvedValue(false);
      globalThis.fetch = vi.fn(async (input) => {
        if (input === '/admin-api/preferences') {
          return makeJsonResponse({ success: true });
        }

        throw new Error(`Unexpected fetch: ${String(input)}`);
      }) as typeof fetch;
      stubColorScheme(true);

      renderLogin();

      await waitFor(() => {
        expect(document.documentElement.classList.contains('dark')).toBe(true);
      });
      expect(document.body.classList.contains('dark')).toBe(true);
      expect(document.documentElement.style.colorScheme).toBe('dark');
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/admin-api/preferences',
        expect.objectContaining({
          body: JSON.stringify({ resolvedTheme: 'dark', theme: 'system' }),
        }),
      );
    });

    it('follows the OS colour scheme while the login screen is open', async () => {
      vi.mocked(browserSupportsWebAuthnAutofill).mockResolvedValue(false);
      globalThis.fetch = vi.fn(async (input) => {
        if (input === '/admin-api/preferences') {
          return makeJsonResponse({ success: true });
        }

        throw new Error(`Unexpected fetch: ${String(input)}`);
      }) as typeof fetch;
      const colorScheme = stubColorScheme(false);

      renderLogin();

      await waitFor(() => {
        expect(document.documentElement.classList.contains('dark')).toBe(false);
      });

      colorScheme.setPrefersDark(true);

      await waitFor(() => {
        expect(document.documentElement.classList.contains('dark')).toBe(true);
      });
      expect(document.body.classList.contains('dark')).toBe(true);
    });

    it('keeps an explicit light theme even when the OS prefers dark', async () => {
      vi.mocked(browserSupportsWebAuthnAutofill).mockResolvedValue(false);
      globalThis.fetch = vi.fn(async (input) => {
        if (input === '/admin-api/preferences') {
          return makeJsonResponse({ success: true });
        }

        throw new Error(`Unexpected fetch: ${String(input)}`);
      }) as typeof fetch;
      stubColorScheme(true);

      renderLogin('light');

      await waitFor(() => {
        expect(globalThis.fetch).toHaveBeenCalledWith(
          '/admin-api/preferences',
          expect.objectContaining({
            body: JSON.stringify({ resolvedTheme: 'light', theme: 'light' }),
          }),
        );
      });
      expect(document.documentElement.classList.contains('dark')).toBe(false);
      expect(document.documentElement.style.colorScheme).toBe('light');
    });
  });
});
