'use client';

import { Block, Flexbox, Input } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { Monitor, Save } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';

/**
 * How long to wait for the main process to bring the gateway back on the new
 * port before reporting that it did not.
 */
const RESTART_TIMEOUT_MS = 15_000;

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
  const restartTimer = useRef<number | null>(null);

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

  useEffect(
    () => () => {
      if (restartTimer.current !== null) {
        window.clearTimeout(restartTimer.current);
        restartTimer.current = null;
      }
    },
    [],
  );

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

      // The main process watches the settings file, restarts the gateway and
      // reloads this window at the address it ended up on — which takes this
      // page, and this timer, down with it. If the timer survives, the restart
      // did not happen: give the button back instead of leaving it spinning,
      // and do not navigate on a guess about which port came up.
      restartTimer.current = window.setTimeout(() => {
        restartTimer.current = null;
        setSaving(false);
        setError(translations('restartFailed'));
      }, RESTART_TIMEOUT_MS);
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
      </div>
      {/*
        No picker for the storage backend: this install is the one place its
        data can be, and a menu with a single disabled entry in it is a choice
        being offered that was never a choice.
      */}
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
