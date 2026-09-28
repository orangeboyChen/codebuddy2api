'use client';

import {
  browserSupportsWebAuthnAutofill,
  startAuthentication,
} from '@simplewebauthn/browser';
import { Block, Flexbox, Input, InputPassword, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { useAtom } from 'jotai';
import { useHydrateAtoms } from 'jotai/utils';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';

import DeploymentPasskeyHint from '@/app/deployment-passkey-hint';
import { themeAtom } from '@/app/page-state';
import { AdminHeader } from '@/app/header';
import type { AdminLoginMessages } from '@/lib/i18n/messages';
import {
  type LocalePreference,
  parseLocalePreference,
} from '@/lib/i18n/routing';
import type { ThemeMode } from '@/lib/theme';
import { saveLocalePreference } from '@/lib/client/preferences';
import { useThemeAppearance } from '@/lib/client/theme';

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
  /**
   * The deployment this console is rendering, when it is rendering one.
   *
   * Its passkeys are bound to this address, not to the loopback address the
   * console is served from, so they cannot be used here.
   */
  deploymentUrl?: string;
  initialTheme?: ThemeMode;
  initialSession: SessionSummary;
  locale: string;
  localePreference?: LocalePreference;
  /** Where to go once signed in, when the sign-in was asked for by a page. */
  nextPath?: string;
  translations: Omit<AdminLoginMessages, 'usernameLabel'> & {
    usernameLabel?: string;
  };
}

const getErrorMessage = (payload: JsonResponse | PasskeyOptionsResponse) => {
  return payload.error?.message ?? 'Request failed';
};

const LoginClient = ({
  deploymentUrl,
  initialSession,
  initialTheme = 'system',
  locale,
  localePreference = parseLocalePreference(locale),
  nextPath,
  translations,
}: LoginClientProps) => {
  const [session, setSession] = useState(initialSession);
  const [password, setPassword] = useState('');
  useHydrateAtoms([[themeAtom, initialTheme]]);
  const [theme, setTheme] = useAtom(themeAtom);
  useThemeAppearance(theme);
  const [username, setUsername] = useState('');
  const [error, setError] = useState('');
  const [isPasskeyPending, setIsPasskeyPending] = useState(false);
  const [isPending, startTransition] = useTransition();
  const autoAttemptedRef = useRef(false);
  const passkeyInFlightRef = useRef(false);

  const passwordMode = session.accountConfigured ? 'login' : 'setup';
  // Offering a passkey here would only ever fail: the ceremony belongs to the
  // deployment's origin, and this page is served from loopback.
  const canUsePasskeys = session.passkeyCount > 0 && !deploymentUrl;
  const passwordLabel =
    passwordMode === 'setup'
      ? translations.createPasswordLabel
      : translations.passwordLabel;
  const [status, setStatus] = useState(
    initialSession.accountConfigured
      ? canUsePasskeys
        ? translations.passwordSignInHint
        : ''
      : translations.createPasswordStatus,
  );

  const changeLocale = (nextLocale: string) => {
    void saveLocalePreference(nextLocale as LocalePreference).finally(() => {
      window.location.reload();
    });
  };

  const applySuccess = useCallback(
    (nextSession?: SessionSummary) => {
      if (nextSession) {
        setSession(nextSession);
      }

      window.location.assign(nextPath ?? '/');
    },
    [nextPath],
  );

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
          canUsePasskeys &&
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
  }, [canUsePasskeys, session.accountConfigured, submitPasskey]);

  return (
    <Flexbox
      as="main"
      className="login-page"
      distribution="center"
      align="center"
    >
      <AdminHeader
        brand="CodeBuddy2API"
        className="login-header"
        localePreference={localePreference}
        onLocaleChange={changeLocale}
        onThemeChange={setTheme}
        theme={theme}
      />
      <Block
        as="section"
        className="login-card"
        direction="vertical"
        gap={24}
        padding={24}
        variant="outlined"
      >
        <Flexbox direction="vertical" gap={8}>
          <Text as="h1" className="login-title" weight={650}>
            {passwordMode === 'setup'
              ? translations.headingSetup
              : translations.headingLogin}
          </Text>
        </Flexbox>

        <Flexbox direction="vertical" gap={16}>
          <Flexbox
            as="form"
            direction="vertical"
            gap={12}
            onSubmit={(event) => {
              event.preventDefault();
              startTransition(() => {
                void submitPassword();
              });
            }}
          >
            <label htmlFor="admin-username">
              <Text weight={500}>
                {translations.usernameLabel ?? 'Admin username'}
              </Text>
            </label>
            <Input
              autoCapitalize="none"
              autoComplete="username webauthn"
              id="admin-username"
              name="username"
              onChange={(event) => {
                setUsername(event.target.value);
              }}
              value={username}
            />
            <label htmlFor="admin-password">
              <Text weight={500}>{passwordLabel}</Text>
            </label>
            <InputPassword
              autoCapitalize="none"
              autoComplete={
                canUsePasskeys
                  ? 'webauthn current-password'
                  : 'current-password'
              }
              id="admin-password"
              name="password"
              onChange={(event) => {
                setPassword(event.target.value);
              }}
              type="password"
              value={password}
            />
            <Button
              disabled={
                isPending ||
                password.trim().length === 0 ||
                username.trim().length === 0
              }
              htmlType="submit"
              type="primary"
            >
              {passwordMode === 'setup'
                ? translations.createPasswordSubmit
                : translations.continueWithPassword}
            </Button>
          </Flexbox>

          <Flexbox aria-live="polite" direction="vertical" gap={4}>
            <Text fontSize={14} type="secondary">
              {status}
            </Text>
            {error ? (
              <Text fontSize={14} type="danger">
                {error}
              </Text>
            ) : null}
          </Flexbox>

          {canUsePasskeys ? (
            <Button
              disabled={isPasskeyPending}
              id="admin-passkey"
              onClick={() => {
                startTransition(() => {
                  void submitPasskey(false);
                });
              }}
              htmlType="button"
            >
              {translations.continueWithPasskey}
            </Button>
          ) : null}
          {deploymentUrl && session.passkeyCount > 0 ? (
            <DeploymentPasskeyHint
              deploymentUrl={deploymentUrl}
              hint={translations.deploymentPasskeyHint}
              openLabel={translations.openDeployment}
            />
          ) : null}
        </Flexbox>
      </Block>
    </Flexbox>
  );
};

export default LoginClient;
