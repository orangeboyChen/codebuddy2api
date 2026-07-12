'use client';

import { startRegistration } from '@simplewebauthn/browser';
import { Block, Flexbox, Input } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { Save, ShieldCheck } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';

interface Passkey {
  id: string;
  name: string;
}

interface SessionSummary {
  accountConfigured: boolean;
  authEnabled: boolean;
  passkeyCount: number;
  passwordConfigured: boolean;
  username: string;
}

interface ApiError {
  error?: { message?: string };
}

const getResponseMessage = async (response: Response, fallback: string) => {
  const payload = (await response.json().catch(() => ({}))) as ApiError;
  return payload.error?.message ?? fallback;
};

const subscribeToPasskeyOrigin = () => () => undefined;

const getPasskeyOriginSupport = () => {
  const hostname = window.location.hostname.toLowerCase();

  return (
    window.location.protocol === 'https:' ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '127.0.0.1' ||
    hostname === '::1'
  );
};

const getServerPasskeyOriginSupport = () => false;

const Security = () => {
  const translations = useTranslations('Admin.securityPanel');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [nextPassword, setNextPassword] = useState('');
  const [passkeyName, setPasskeyName] = useState('');
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [status, setStatus] = useState('');
  const [username, setUsername] = useState('');
  const passkeysSupported = useSyncExternalStore(
    subscribeToPasskeyOrigin,
    getPasskeyOriginSupport,
    getServerPasskeyOriginSupport,
  );

  const loadState = async () => {
    const response = await fetch('/admin-api/auth/session');
    const payload = (await response.json()) as { session?: SessionSummary };
    const nextSession = payload.session ?? null;
    setSession(nextSession);
    setUsername(nextSession?.username ?? 'admin');

    if (!nextSession?.authEnabled) {
      setPasskeys([]);
      return;
    }

    const passkeysResponse = await fetch('/admin-api/auth/passkeys');
    if (!passkeysResponse.ok) {
      return;
    }

    const passkeysPayload = (await passkeysResponse.json()) as {
      passkeys?: Passkey[];
    };
    setPasskeys(passkeysPayload.passkeys ?? []);
  };

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void loadState();
    }, 0);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, []);

  const saveAccount = async () => {
    if (nextPassword !== confirmPassword) {
      setStatus(translations('passwordMismatch'));
      return;
    }

    const isSetup = !session?.authEnabled;
    const response = await fetch(
      isSetup ? '/admin-api/auth/setup' : '/admin-api/auth/password',
      {
        body: JSON.stringify(
          isSetup
            ? { password: nextPassword, username }
            : { currentPassword, nextPassword, username },
        ),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      },
    );

    setStatus(
      response.ok
        ? isSetup
          ? translations('authEnabled')
          : translations('accountUpdated')
        : await getResponseMessage(
            response,
            isSetup
              ? translations('authEnabled')
              : translations('accountUpdated'),
          ),
    );

    if (response.ok) {
      setConfirmPassword('');
      setCurrentPassword('');
      setNextPassword('');
      await loadState();
    }
  };

  const addPasskey = async () => {
    if (!passkeysSupported) {
      setStatus(translations('passkeyUnavailable'));
      return;
    }

    const optionsResponse = await fetch(
      '/admin-api/auth/passkeys/registration/options',
      {
        body: JSON.stringify({ name: passkeyName }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      },
    );
    const optionsPayload = (await optionsResponse.json().catch(() => ({}))) as {
      error?: { message?: string };
      name?: string;
      options?: Parameters<typeof startRegistration>[0]['optionsJSON'];
    };

    if (!optionsResponse.ok || !optionsPayload.options) {
      setStatus(
        optionsPayload.error?.message ?? translations('passkeyOptionsFailed'),
      );
      return;
    }

    try {
      const credential = await startRegistration({
        optionsJSON: optionsPayload.options,
      });
      const verifyResponse = await fetch(
        '/admin-api/auth/passkeys/registration/verify',
        {
          body: JSON.stringify({
            name: optionsPayload.name ?? passkeyName,
            response: credential,
          }),
          headers: { 'Content-Type': 'application/json' },
          method: 'POST',
        },
      );
      setStatus(
        verifyResponse.ok
          ? translations('passkeyAdded')
          : await getResponseMessage(
              verifyResponse,
              translations('passkeyAddFailed'),
            ),
      );
      if (verifyResponse.ok) {
        setPasskeyName('');
        await loadState();
      }
    } catch (error) {
      setStatus(
        error instanceof Error
          ? error.message
          : translations('passkeyAddFailed'),
      );
    }
  };

  const deletePasskey = async (id: string) => {
    const response = await fetch(`/admin-api/auth/passkeys/${id}`, {
      method: 'DELETE',
    });
    setStatus(
      response.ok
        ? translations('passkeyDeleted')
        : await getResponseMessage(
            response,
            translations('passkeyDeleteFailed'),
          ),
    );
    if (response.ok) {
      await loadState();
    }
  };

  const disableAuth = async () => {
    if (!window.confirm(translations('confirmDisable'))) {
      return;
    }

    const response = await fetch('/admin-api/auth/password', {
      method: 'DELETE',
    });
    if (response.ok) {
      window.location.assign('/');
      return;
    }

    setStatus(
      await getResponseMessage(response, translations('disableFailed')),
    );
  };

  const authEnabled = Boolean(session?.authEnabled);

  return (
    <Block
      className="mb-6"
      direction="vertical"
      gap={16}
      padding={24}
      variant="outlined"
    >
      <Flexbox align="center" distribution="space-between" horizontal>
        <div>
          <Flexbox align="center" gap={8} horizontal>
            <ShieldCheck aria-hidden="true" size={18} strokeWidth={2} />
            <h3 className="section-title">{translations('title')}</h3>
          </Flexbox>
          <p className="mt-1 text-sm text-secondary">
            {authEnabled ? translations('enabled') : translations('disabled')}
          </p>
        </div>
      </Flexbox>

      <div className="grid gap-4">
        <label className="grid gap-2 text-sm text-text-light dark:text-text-dark">
          {translations('username')}
          <Input
            onChange={(event) => setUsername(event.target.value)}
            value={username}
          />
        </label>
        {authEnabled ? (
          <label className="grid gap-2 text-sm text-text-light dark:text-text-dark">
            {translations('currentPassword')}
            <Input
              onChange={(event) => setCurrentPassword(event.target.value)}
              type="password"
              value={currentPassword}
            />
          </label>
        ) : null}
        <label className="grid gap-2 text-sm text-text-light dark:text-text-dark">
          {authEnabled ? translations('newPassword') : translations('password')}
          <Input
            onChange={(event) => setNextPassword(event.target.value)}
            placeholder={translations('minimumPassword')}
            type="password"
            value={nextPassword}
          />
        </label>
        <label className="grid gap-2 text-sm text-text-light dark:text-text-dark">
          {translations('confirmPassword')}
          <Input
            onChange={(event) => setConfirmPassword(event.target.value)}
            type="password"
            value={confirmPassword}
          />
        </label>
        <div className="flex flex-wrap gap-3">
          <Button
            icon={Save}
            onClick={() => void saveAccount()}
            htmlType="button"
            type="primary"
          >
            {authEnabled
              ? translations('update')
              : translations('saveAndEnable')}
          </Button>
          {authEnabled ? (
            <Button danger onClick={() => void disableAuth()} htmlType="button">
              {translations('disable')}
            </Button>
          ) : null}
        </div>
      </div>

      {authEnabled ? (
        <div className="mt-6">
          <Flexbox align="center" gap={8} horizontal>
            <ShieldCheck aria-hidden="true" size={18} strokeWidth={2} />
            <h4 className="dashboard-data-title">
              {translations('passkeyHeading')}
            </h4>
          </Flexbox>
          <div className="mt-4 flex flex-wrap gap-3">
            <Input
              className="flex-1 min-w-48"
              disabled={!passkeysSupported}
              onChange={(event) => setPasskeyName(event.target.value)}
              placeholder={translations('passkeyName')}
              value={passkeyName}
            />
            <Button
              disabled={!passkeysSupported}
              onClick={() => void addPasskey()}
              htmlType="button"
            >
              {translations('addPasskey')}
            </Button>
          </div>
          {!passkeysSupported ? (
            <p className="mt-3 text-sm text-secondary">
              {translations('passkeyUnavailable')}
            </p>
          ) : null}
          {passkeys.length ? (
            <ul className="mt-4 grid gap-2">
              {passkeys.map((passkey) => (
                <li
                  className="flex items-center justify-between gap-3"
                  key={passkey.id}
                >
                  <span>{passkey.name}</span>
                  <Button
                    danger
                    onClick={() => void deletePasskey(passkey.id)}
                    htmlType="button"
                  >
                    {translations('delete')}
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-4 text-sm text-secondary">
              {translations('noPasskeys')}
            </p>
          )}
        </div>
      ) : null}
      {status ? <p className="mt-4 text-sm text-secondary">{status}</p> : null}
    </Block>
  );
};

export default Security;
