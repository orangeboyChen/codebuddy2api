'use client';

import {
  browserSupportsWebAuthnAutofill,
  startAuthentication,
} from '@simplewebauthn/browser';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';

import type { AdminLoginMessages } from '@/lib/i18n/messages';
import { localeCookieName, locales } from '@/lib/i18n/routing';
import {
  resolvedThemeCookieName,
  themeCookieName,
  type ThemeMode,
} from '@/lib/theme';

interface SessionSummary {
  accountConfigured: boolean;
  authEnabled?: boolean;
  authenticated: boolean;
  passkeyCount: number;
  passwordConfigured: boolean;
  username?: string;
}

interface JsonResponse {
  error?: {
    message?: string;
  };
  session?: SessionSummary;
  success?: boolean;
}

interface PasskeyOptionsResponse {
  error?: {
    message?: string;
  };
  options?: Parameters<typeof startAuthentication>[0]['optionsJSON'];
}

interface LoginClientProps {
  initialTheme?: ThemeMode;
  initialSession: SessionSummary;
  locale: string;
  themeLabels?: Record<ThemeMode, string>;
  translations: Omit<AdminLoginMessages, 'usernameLabel'> & {
    usernameLabel?: string;
  };
}

const getErrorMessage = (payload: JsonResponse | PasskeyOptionsResponse) => {
  return payload.error?.message ?? 'Request failed';
};

const LoginClient = ({
  initialSession,
  initialTheme = 'system',
  locale,
  themeLabels = { dark: 'Dark', light: 'Light', system: 'System' },
  translations,
}: LoginClientProps) => {
  const [session, setSession] = useState(initialSession);
  const [password, setPassword] = useState('');
  const [theme, setTheme] = useState<ThemeMode>(initialTheme);
  const [username, setUsername] = useState(initialSession.username ?? 'admin');
  const [error, setError] = useState('');
  const [isPasskeyPending, setIsPasskeyPending] = useState(false);
  const [isPending, startTransition] = useTransition();
  const autoAttemptedRef = useRef(false);
  const passkeyInFlightRef = useRef(false);

  const passwordMode = session.accountConfigured ? 'login' : 'setup';
  const canUsePasskeys = session.passkeyCount > 0;
  const passwordLabel =
    passwordMode === 'setup'
      ? translations.createPasswordLabel
      : translations.passwordLabel;
  const [status, setStatus] = useState(
    initialSession.accountConfigured
      ? initialSession.passkeyCount > 0
        ? translations.passwordSignInHint
        : translations.errorPasswordStatus
      : translations.createPasswordStatus,
  );

  const changeLocale = (nextLocale: string) => {
    document.cookie = `${localeCookieName}=${nextLocale}; Path=/; Max-Age=31536000; SameSite=Lax`;
    window.location.reload();
  };

  const changeTheme = (nextTheme: ThemeMode) => {
    const isDark =
      nextTheme === 'dark' ||
      (nextTheme === 'system' &&
        window.matchMedia('(prefers-color-scheme: dark)').matches);
    setTheme(nextTheme);
    document.documentElement.classList.toggle('dark', isDark);
    document.documentElement.style.colorScheme = isDark ? 'dark' : 'light';
    document.cookie = `${themeCookieName}=${nextTheme}; Path=/; Max-Age=31536000; SameSite=Lax`;
    document.cookie = `${resolvedThemeCookieName}=${isDark ? 'dark' : 'light'}; Path=/; Max-Age=31536000; SameSite=Lax`;
  };

  const applySuccess = useCallback((nextSession?: SessionSummary) => {
    if (nextSession) {
      setSession(nextSession);
    }

    window.location.assign('/');
  }, []);

  const submitPassword = async () => {
    const endpoint =
      passwordMode === 'setup'
        ? '/admin-api/auth/setup'
        : '/admin-api/auth/session';

    setError('');
    setStatus(
      passwordMode === 'setup'
        ? translations.signInWithPassword
        : translations.signingInPassword,
    );

    const response = await fetch(endpoint, {
      body: JSON.stringify({ password, username }),
      headers: {
        'Content-Type': 'application/json',
      },
      method: 'POST',
    });
    const payload = (await response.json()) as JsonResponse;

    if (!response.ok || !payload.success || !payload.session) {
      setError(getErrorMessage(payload));
      setStatus(
        passwordMode === 'setup'
          ? translations.createPasswordStatus
          : translations.errorPasswordStatus,
      );
      return;
    }

    setStatus(
      passwordMode === 'setup'
        ? translations.createAccountRedirecting
        : translations.passwordAccepted,
    );
    applySuccess(payload.session);
  };

  const submitPasskey = useCallback(
    async (useBrowserAutofill: boolean) => {
      if (passkeyInFlightRef.current) {
        return;
      }

      passkeyInFlightRef.current = true;
      setIsPasskeyPending(true);
      setError('');
      setStatus(
        useBrowserAutofill
          ? translations.waitingForPasskey
          : translations.passkeyStatusManual,
      );

      try {
        const optionsResponse = await fetch(
          '/admin-api/auth/passkeys/authentication/options',
          {
            method: 'POST',
          },
        );
        const optionsPayload =
          (await optionsResponse.json()) as PasskeyOptionsResponse;

        if (!optionsResponse.ok || !optionsPayload.options) {
          setError(getErrorMessage(optionsPayload));
          setStatus(translations.errorPasskeyUnavailable);
          return;
        }

        const credential = await startAuthentication({
          optionsJSON: optionsPayload.options,
          useBrowserAutofill,
          verifyBrowserAutofillInput: false,
        });

        const verifyResponse = await fetch(
          '/admin-api/auth/passkeys/authentication/verify',
          {
            body: JSON.stringify({ response: credential }),
            headers: {
              'Content-Type': 'application/json',
            },
            method: 'POST',
          },
        );
        const verifyPayload = (await verifyResponse.json()) as JsonResponse;

        if (
          !verifyResponse.ok ||
          !verifyPayload.success ||
          !verifyPayload.session
        ) {
          setError(getErrorMessage(verifyPayload));
          setStatus(translations.errorPasskeyFailed);
          return;
        }

        setStatus(translations.passkeyAccepted);
        applySuccess(verifyPayload.session);
      } catch (caughtError) {
        const message =
          caughtError instanceof Error
            ? caughtError.message
            : 'Passkey sign-in failed';
        setError(message);
        setStatus(translations.errorPasskeyFailed);
      } finally {
        passkeyInFlightRef.current = false;
        setIsPasskeyPending(false);
      }
    },
    [applySuccess, translations],
  );

  useEffect(() => {
    let disposed = false;

    void browserSupportsWebAuthnAutofill()
      .then((supported) => {
        if (disposed) {
          return;
        }

        if (
          supported &&
          session.accountConfigured &&
          session.passkeyCount > 0 &&
          !autoAttemptedRef.current
        ) {
          autoAttemptedRef.current = true;
          void submitPasskey(true);
        }
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
    };
  }, [session.accountConfigured, session.passkeyCount, submitPasskey]);

  return (
    <main className="login-page">
      <header className="login-header">
        <div className="login-header-brand">CodeBuddy2API</div>
        <div className="login-header-controls">
          <select
            aria-label="Language"
            onChange={(event) => changeLocale(event.target.value)}
            value={locale}
          >
            {locales.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
          <select
            aria-label="Theme mode"
            onChange={(event) => changeTheme(event.target.value as ThemeMode)}
            value={theme}
          >
            <option value="light">{themeLabels.light}</option>
            <option value="dark">{themeLabels.dark}</option>
            <option value="system">{themeLabels.system}</option>
          </select>
        </div>
      </header>
      <section className="login-card">
        <div className="login-hero">
          <p className="login-eyebrow">CodeBuddy2API Admin</p>
          <h1 className="login-title">
            {passwordMode === 'setup'
              ? translations.headingSetup
              : translations.headingLogin}
          </h1>
        </div>

        <div className="login-surface">
          <form
            className="login-form"
            onSubmit={(event) => {
              event.preventDefault();
              startTransition(() => {
                void submitPassword();
              });
            }}
          >
            <label className="login-label" htmlFor="admin-username">
              {translations.usernameLabel ?? 'Admin username'}
            </label>
            <input
              autoCapitalize="none"
              autoComplete="username webauthn"
              className="login-input"
              id="admin-username"
              name="username"
              onChange={(event) => {
                setUsername(event.target.value);
              }}
              value={username}
            />
            <label className="login-label" htmlFor="admin-password">
              {passwordLabel}
            </label>
            <input
              autoCapitalize="none"
              autoComplete={
                canUsePasskeys
                  ? 'webauthn current-password'
                  : 'current-password'
              }
              className="login-input"
              id="admin-password"
              name="password"
              onChange={(event) => {
                setPassword(event.target.value);
              }}
              placeholder={
                passwordMode === 'setup'
                  ? translations.createPasswordPlaceholder
                  : translations.passwordLabel
              }
              type="password"
              value={password}
            />
            <button
              className="login-primary-button"
              disabled={
                isPending ||
                password.trim().length === 0 ||
                username.trim().length === 0
              }
              type="submit"
            >
              {passwordMode === 'setup'
                ? translations.createPasswordSubmit
                : translations.continueWithPassword}
            </button>
          </form>

          <div className="login-meta-row" aria-live="polite">
            <span className="login-status">{status}</span>
            {error ? <span className="login-error">{error}</span> : null}
          </div>

          {canUsePasskeys ? (
            <button
              className="login-secondary-button"
              disabled={isPasskeyPending}
              onClick={() => {
                startTransition(() => {
                  void submitPasskey(false);
                });
              }}
              type="button"
            >
              {translations.continueWithPasskey}
            </button>
          ) : null}
        </div>
      </section>
    </main>
  );
};

export default LoginClient;
