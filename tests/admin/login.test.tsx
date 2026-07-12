// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import LoginClient from '@/features/admin/login-client';
import type { AdminLoginMessages } from '@/lib/i18n/messages';

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

const loginTranslations: AdminLoginMessages = {
  autofillAvailable: 'Passkey autofill is available.',
  autofillUnavailable: 'Passkey autofill is unavailable.',
  continueWithPasskey: 'Continue with passkey',
  continueWithPassword: 'Continue with password',
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
  headingLogin: 'Sign in to the admin console',
  headingSetup: 'Set up the admin account',
  noPasskeysConfigured: 'No passkeys are configured.',
  orLabel: 'or',
  passkeyAccepted: 'Passkey accepted. Redirecting...',
  passkeyHintLogin: 'after the first account is configured.',
  passkeyHintSetup: 'and signs you in immediately.',
  passkeyStatusManual: 'Opening the passkey prompt...',
  passwordAccepted: 'Password accepted. Redirecting...',
  passwordLabel: 'Admin password',
  passwordSignInHint: 'Use your password or a saved passkey to continue.',
  signInWithPassword: 'Creating the admin account...',
  signingInPassword: 'Signing in with password...',
  title: 'Admin sign in',
  usernameLabel: 'Admin username',
  waitingForPasskey: 'Waiting for a saved passkey...',
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

    render(
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

    fireEvent.change(screen.getByLabelText('Admin username'), {
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

    render(
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

    fireEvent.change(screen.getByLabelText('Admin username'), {
      target: { value: 'admin' },
    });
    fireEvent.change(screen.getByLabelText('Admin password'), {
      target: { value: 'secret-password' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Continue with password' }),
    );

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

    render(
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
});
