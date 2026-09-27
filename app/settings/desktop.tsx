'use client';

import { Block, Flexbox, Input } from '@lobehub/ui';
import { Button, Select } from '@lobehub/ui/base-ui';
import { Monitor, Save } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

interface DesktopState {
  desktop: boolean;
  port: number;
  preferredPort: number;
  storageBackend: string;
}

/**
 * The desktop-only part of the settings page. It renders nothing on a server
 * deployment, where the port belongs to the container and the storage backend
 * is chosen with environment variables.
 */
const Desktop = () => {
  const translations = useTranslations('Admin.desktopPanel');
  const [state, setState] = useState<DesktopState | null>(null);
  const [port, setPort] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch('/admin-api/desktop');

        if (!response.ok) {
          return;
        }

        const data = (await response.json()) as DesktopState;

        if (cancelled) {
          return;
        }

        setState(data);
        setPort(String(data.preferredPort || ''));
      } catch {
        // Not signed in, or not the desktop app: the section stays hidden.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  if (!state?.desktop) {
    return null;
  }

  const save = async () => {
    setSaving(true);
    setError('');

    try {
      const response = await fetch('/admin-api/desktop', {
        body: JSON.stringify({ port }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });
      const data = (await response.json()) as DesktopState & {
        error?: { message?: string };
      };

      if (!response.ok) {
        setError(data?.error?.message ?? translations('saveFailed'));
        setSaving(false);

        return;
      }

      setState(data);

      // The main process restarts the gateway and reloads this window at its
      // new address. Navigate anyway: if the gateway is slow to come back, the
      // page the user is looking at is already the old one.
      window.setTimeout(() => {
        window.location.href = `http://127.0.0.1:${data.preferredPort}/dashboard`;
      }, 4000);
    } catch {
      setError(translations('saveFailed'));
      setSaving(false);
    }
  };

  return (
    <Block
      className="min-w-0 max-w-full"
      direction="vertical"
      gap={16}
      padding={24}
      variant="outlined"
    >
      <Flexbox align="center" gap={8} horizontal>
        <Monitor size={18} strokeWidth={2} />
        <h3 className="section-title">{translations('title')}</h3>
      </Flexbox>
      <div className="mb-4">
        <label
          className="mb-2 block whitespace-normal break-words font-medium text-text-light dark:text-text-dark"
          htmlFor="desktopPort"
        >
          {translations('portLabel')}
        </label>
        <Input
          id="desktopPort"
          onChange={(event) => setPort(event.target.value)}
          type="text"
          value={port}
        />
        <p className="mt-2 text-secondary">
          {translations('portHint', { port: state.port })}
        </p>
      </div>
      <div className="mb-4">
        <label
          className="mb-2 block whitespace-normal break-words font-medium text-text-light dark:text-text-dark"
          htmlFor="desktopStorageBackend"
        >
          {translations('storageLabel')}
        </label>
        <Select
          className="w-full"
          disabled
          id="desktopStorageBackend"
          options={[{ label: 'SQLite', value: 'sqlite' }]}
          value={state.storageBackend}
        />
        <p className="mt-2 text-secondary">{translations('storageHint')}</p>
      </div>
      <Flexbox horizontal>
        <Button
          disabled={saving}
          icon={Save}
          loading={saving}
          onClick={() => void save()}
          type="primary"
        >
          {translations('save')}
        </Button>
      </Flexbox>
      {saving ? (
        <p className="text-secondary">{translations('restarting')}</p>
      ) : null}
      {error ? <p className="text-secondary">{error}</p> : null}
    </Block>
  );
};

export default Desktop;
