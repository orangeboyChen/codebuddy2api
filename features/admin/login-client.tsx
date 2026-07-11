'use client';

import {
  browserSupportsWebAuthnAutofill,
  startAuthentication,
} from '@simplewebauthn/browser';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';

import type { AdminLoginMessages } from '@/lib/i18n/messages';

interface SessionSummary {
  accountConfigured: boolean;
  authenticated: boolean;
  passkeyCount: number;
  passwordConfigured: boolean;
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
  initialSession: SessionSummary;
  locale: string;
  translations: AdminLoginMessages;
}

const getErrorMessage = (payload: JsonResponse | PasskeyOptionsResponse) => {
  return payload.error?.message ?? 'Request failed';
};

const LoginClient = ({
  initialSession,
  locale: _locale,
  translations,
}: LoginClientProps) => {
  const [session, setSession] = useState(initialSession);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [supportsPasskey, setSupportsPasskey] = useState(false);
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

  const applySuccess = useCallback((nextSession?: SessionSummary) => {
    if (nextSession) {
      setSession(nextSession);
    }

    window.location.assign('/admin');
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
      body: JSON.stringify({ password }),
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

        setSupportsPasskey(supported);

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
      .catch(() => {
        if (!disposed) {
          setSupportsPasskey(false);
        }
      });

    return () => {
      disposed = true;
    };
  }, [session.accountConfigured, session.passkeyCount, submitPasskey]);

  return (
    <main className="login-page">
      <section className="login-card">
        <div className="login-hero">
          <p className="login-eyebrow">CodeBuddy2API Admin</p>
          <h1 className="login-title">
            {passwordMode === 'setup'
              ? translations.headingSetup
              : translations.headingLogin}
          </h1>
          <p className="login-description">
            {passwordMode === 'setup'
              ? translations.descriptionSetup
              : translations.descriptionLogin}
          </p>
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
              disabled={isPending || password.trim().length === 0}
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

          <div className="login-divider" role="presentation">
            <span>{translations.orLabel}</span>
          </div>

          <button
            className="login-secondary-button"
            disabled={!canUsePasskeys || isPasskeyPending}
            onClick={() => {
              startTransition(() => {
                void submitPasskey(false);
              });
            }}
            type="button"
          >
            {translations.continueWithPasskey}
          </button>

          <ul className="login-hints">
            <li>
              Password login uses <code>/admin-api/auth/session</code>{' '}
              {translations.passkeyHintLogin}
            </li>
            <li>
              First-time setup uses <code>/admin-api/auth/setup</code>{' '}
              {translations.passkeyHintSetup}
            </li>
            <li>
              {canUsePasskeys
                ? supportsPasskey
                  ? translations.autofillAvailable
                  : translations.autofillUnavailable
                : translations.noPasskeysConfigured}
            </li>
          </ul>
        </div>
      </section>
    </main>
  );
};

export default LoginClient;
