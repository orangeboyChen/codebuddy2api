'use client';

import { startRegistration } from '@simplewebauthn/browser';
import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import type { AppLocale } from '@/lib/i18n/routing';

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

const AdminAuthSettings = () => {
  const locale = useLocale() as AppLocale;
  const translations = useTranslations('Admin.securityPanel');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [nextPassword, setNextPassword] = useState('');
  const [passkeyName, setPasskeyName] = useState('');
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [status, setStatus] = useState('');
  const [username, setUsername] = useState('');

  const localeText = {
    'en-US': {
      accountUpdated: 'Administrator account updated.',
      authEnabled: 'Administrator authentication enabled.',
      confirmDisable:
        'Disabling authentication will remove the admin password and all passkeys. Continue?',
      disableFailed: 'Failed to disable administrator authentication.',
      passkeyAdded: 'Passkey added.',
      passkeyAddFailed: 'Failed to add passkey.',
      passkeyDeleted: 'Passkey deleted.',
      passkeyDeleteFailed: 'Failed to delete passkey.',
      passkeyOptionsFailed: 'Unable to create a passkey registration request.',
      passwordMismatch: 'The passwords do not match.',
      passkeyHeading: 'Passkeys',
    },
    'ja-JP': {
      accountUpdated: '管理者アカウントを更新しました。',
      authEnabled: '管理者認証を有効化しました。',
      confirmDisable:
        '認証を無効にすると、管理者パスワードとすべての passkey が削除されます。続行しますか？',
      disableFailed: '管理者認証を無効化できませんでした。',
      passkeyAdded: 'Passkey を追加しました。',
      passkeyAddFailed: 'Passkey の追加に失敗しました。',
      passkeyDeleted: 'Passkey を削除しました。',
      passkeyDeleteFailed: 'Passkey の削除に失敗しました。',
      passkeyOptionsFailed: 'Passkey 登録リクエストを作成できませんでした。',
      passwordMismatch: '入力したパスワードが一致しません。',
      passkeyHeading: 'Passkeys',
    },
    'zh-CN': {
      accountUpdated: '管理员账户已更新。',
      authEnabled: '管理员鉴权已启用。',
      confirmDisable: '关闭后将删除管理员密码和所有 Passkey。是否继续？',
      disableFailed: '关闭管理员鉴权失败。',
      passkeyAdded: 'Passkey 已添加。',
      passkeyAddFailed: 'Passkey 添加失败。',
      passkeyDeleted: 'Passkey 已删除。',
      passkeyDeleteFailed: 'Passkey 删除失败。',
      passkeyOptionsFailed: '无法创建 Passkey 注册请求。',
      passwordMismatch: '两次输入的密码不一致。',
      passkeyHeading: 'Passkey',
    },
  }[locale];

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
      setStatus(localeText.passwordMismatch);
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
          ? localeText.authEnabled
          : localeText.accountUpdated
        : await getResponseMessage(
            response,
            isSetup ? localeText.authEnabled : localeText.accountUpdated,
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
        optionsPayload.error?.message ?? localeText.passkeyOptionsFailed,
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
          ? localeText.passkeyAdded
          : await getResponseMessage(
              verifyResponse,
              localeText.passkeyAddFailed,
            ),
      );
      if (verifyResponse.ok) {
        setPasskeyName('');
        await loadState();
      }
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : localeText.passkeyAddFailed,
      );
    }
  };

  const deletePasskey = async (id: string) => {
    const response = await fetch(`/admin-api/auth/passkeys/${id}`, {
      method: 'DELETE',
    });
    setStatus(
      response.ok
        ? localeText.passkeyDeleted
        : await getResponseMessage(response, localeText.passkeyDeleteFailed),
    );
    if (response.ok) {
      await loadState();
    }
  };

  const disableAuth = async () => {
    if (!window.confirm(localeText.confirmDisable)) {
      return;
    }

    const response = await fetch('/admin-api/auth/password', {
      method: 'DELETE',
    });
    if (response.ok) {
      window.location.assign('/');
      return;
    }

    setStatus(await getResponseMessage(response, localeText.disableFailed));
  };

  const authEnabled = Boolean(session?.authEnabled);

  return (
    <section className="bg-card-light dark:bg-card-dark border border-border-light dark:border-border-dark p-6 mb-6 shadow-sm transition-all">
      <div className="flex justify-between items-center mb-4 pb-4 border-b border-border-light dark:border-border-dark">
        <div>
          <h3 className="text-lg font-semibold font-serif text-text-light dark:text-text-dark">
            {translations('title')}
          </h3>
          <p className="mt-1 text-sm text-secondary">
            {authEnabled ? translations('enabled') : translations('disabled')}
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm text-text-light dark:text-text-dark">
          <input
            checked={authEnabled}
            onChange={() => {
              if (authEnabled) {
                void disableAuth();
                return;
              }

              void saveAccount();
            }}
            type="checkbox"
          />
          {translations('enable')}
        </label>
      </div>

      <div className="grid gap-4">
        <label className="grid gap-2 text-sm text-text-light dark:text-text-dark">
          {translations('username')}
          <input
            className="p-3 border border-border-light dark:border-border-dark bg-bg-light dark:bg-bg-dark text-text-light dark:text-text-dark"
            onChange={(event) => setUsername(event.target.value)}
            value={username}
          />
        </label>
        {authEnabled ? (
          <label className="grid gap-2 text-sm text-text-light dark:text-text-dark">
            {translations('currentPassword')}
            <input
              className="p-3 border border-border-light dark:border-border-dark bg-bg-light dark:bg-bg-dark text-text-light dark:text-text-dark"
              onChange={(event) => setCurrentPassword(event.target.value)}
              type="password"
              value={currentPassword}
            />
          </label>
        ) : null}
        <label className="grid gap-2 text-sm text-text-light dark:text-text-dark">
          {authEnabled ? translations('newPassword') : translations('password')}
          <input
            className="p-3 border border-border-light dark:border-border-dark bg-bg-light dark:bg-bg-dark text-text-light dark:text-text-dark"
            onChange={(event) => setNextPassword(event.target.value)}
            placeholder={translations('minimumPassword')}
            type="password"
            value={nextPassword}
          />
        </label>
        <label className="grid gap-2 text-sm text-text-light dark:text-text-dark">
          {translations('confirmPassword')}
          <input
            className="p-3 border border-border-light dark:border-border-dark bg-bg-light dark:bg-bg-dark text-text-light dark:text-text-dark"
            onChange={(event) => setConfirmPassword(event.target.value)}
            type="password"
            value={confirmPassword}
          />
        </label>
        <div className="flex flex-wrap gap-3">
          <button
            className="inline-flex items-center gap-2 px-6 py-3 border-none font-medium cursor-pointer transition-all text-sm bg-primary text-white hover:bg-primary-dark"
            onClick={() => void saveAccount()}
            type="button"
          >
            <i className="fas fa-shield-alt"></i>
            {authEnabled
              ? translations('update')
              : translations('saveAndEnable')}
          </button>
          {authEnabled ? (
            <button
              className="inline-flex items-center gap-2 px-6 py-3 border border-error font-medium cursor-pointer transition-all text-sm text-error"
              onClick={() => void disableAuth()}
              type="button"
            >
              {translations('disable')}
            </button>
          ) : null}
        </div>
      </div>

      {authEnabled ? (
        <div className="mt-6 pt-6 border-t border-border-light dark:border-border-dark">
          <h4 className="text-primary mb-4">{localeText.passkeyHeading}</h4>
          <div className="flex flex-wrap gap-3">
            <input
              className="flex-1 min-w-48 p-3 border border-border-light dark:border-border-dark bg-bg-light dark:bg-bg-dark text-text-light dark:text-text-dark"
              onChange={(event) => setPasskeyName(event.target.value)}
              placeholder={translations('passkeyName')}
              value={passkeyName}
            />
            <button
              className="px-4 py-2 bg-secondary text-white"
              onClick={() => void addPasskey()}
              type="button"
            >
              {translations('addPasskey')}
            </button>
          </div>
          {passkeys.length ? (
            <ul className="mt-4 grid gap-2">
              {passkeys.map((passkey) => (
                <li
                  className="flex items-center justify-between gap-3 p-3 border border-border-light dark:border-border-dark"
                  key={passkey.id}
                >
                  <span>{passkey.name}</span>
                  <button
                    className="text-sm text-error"
                    onClick={() => void deletePasskey(passkey.id)}
                    type="button"
                  >
                    {translations('delete')}
                  </button>
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
    </section>
  );
};

export default AdminAuthSettings;
