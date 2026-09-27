import { Flexbox, Input, Text } from '@lobehub/ui';
import { Button, RadioGroup } from '@lobehub/ui/base-ui';
import type { InputRef } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import LobeUiProvider from '@/app/lobe-ui-provider';
import type { DesktopText } from '@/lib/server/electron/desktop-text';
import type { DesktopBackend } from '@/lib/server/electron/settings';

interface BackendInfo {
  backend: DesktopBackend;
  locale: string;
  /** Absent from a main process that only ever had the one screen. */
  screen?: 'choose' | 'unreachable';
  text: DesktopText;
  unreachable?: { host: string; message: string } | null;
}

interface DesktopBridge {
  getInfo: () => Promise<BackendInfo>;
  openInBrowser: () => Promise<void>;
  retryBackend: () => Promise<void>;
  setBackend: (backend: DesktopBackend) => Promise<void>;
}

// The preload bridge, reached through the one cast the page needs: a bundled
// page has no Electron types to describe `window.desktop` with.
const bridge = (window as unknown as { desktop: DesktopBridge }).desktop;

/**
 * The address the app would open, or null when it is not one.
 *
 * The same check the main process makes, run here so the field can be put
 * right instead of the choice quietly falling back to the local gateway.
 */
const parseUrl = (value: string): string | null => {
  try {
    const parsed = new URL(value.trim());

    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? parsed.href
      : null;
  } catch {
    return null;
  }
};

interface OptionProps {
  hint: string;
  label: string;
}

const Option = ({ hint, label }: OptionProps) => (
  <Flexbox gap={2}>
    <Text weight={600}>{label}</Text>
    <Text fontSize={12} lineHeight={1.4} type="secondary">
      {hint}
    </Text>
  </Flexbox>
);

interface ChooseProps {
  backend: DesktopBackend;
  text: DesktopText;
}

const Choose = ({ backend, text }: ChooseProps) => {
  const [mode, setMode] = useState<'local' | 'remote'>(backend.mode);
  const [url, setUrl] = useState(backend.mode === 'remote' ? backend.url : '');
  const [error, setError] = useState('');
  const field = useRef<InputRef>(null);

  useEffect(() => {
    // Naming a deployment is a decision to type its address, so the caret
    // belongs in the field rather than waiting for a click.
    if (mode === 'remote') {
      field.current?.focus();
    }
  }, [mode]);

  const save = () => {
    if (mode === 'local') {
      void bridge.setBackend({ mode: 'local' });

      return;
    }

    const parsed = parseUrl(url);

    if (!parsed) {
      setError(text.invalidBackendUrl);

      return;
    }

    void bridge.setBackend({ mode: 'remote', url: parsed });
  };

  return (
    <>
      <Text as="h1" fontSize={16} id="title" weight={600}>
        {text.chooseBackend}
      </Text>
      <RadioGroup
        gap={12}
        horizontal={false}
        onChange={(value) => {
          setError('');
          setMode(value === 'remote' ? 'remote' : 'local');
        }}
        options={[
          {
            label: (
              <Option hint={text.backendLocalHint} label={text.backendLocal} />
            ),
            value: 'local',
          },
          {
            label: (
              <Option
                hint={text.backendRemoteHint}
                label={text.backendRemote}
              />
            ),
            value: 'remote',
          },
        ]}
        value={mode}
      />
      <Input
        disabled={mode !== 'remote'}
        id="url"
        onChange={(event) => {
          setError('');
          setUrl(event.target.value);
        }}
        placeholder={text.backendUrlPlaceholder}
        ref={field}
        value={url}
      />
      {error ? (
        <Text fontSize={12} type="danger">
          {error}
        </Text>
      ) : null}
      <Flexbox gap={8} horizontal justify="flex-end">
        {/* Closing without answering leaves the app on the backend it was
            already using — or on the local gateway, on a first launch. */}
        <Button onClick={() => window.close()}>{text.cancel}</Button>
        <Button id="save" onClick={save} type="primary">
          {text.save}
        </Button>
      </Flexbox>
    </>
  );
};

interface UnreachableProps {
  onChoose: () => void;
  text: DesktopText;
  unreachable: { host: string; message: string };
}

const Unreachable = ({ onChoose, text, unreachable }: UnreachableProps) => (
  <>
    <Text as="h1" fontSize={16} weight={600}>
      {text.unreachableTitle}
    </Text>
    {/* The main process already filled the host into this one. */}
    <Text lineHeight={1.5} type="secondary">
      {unreachable.message}
    </Text>
    <Flexbox gap={8} horizontal justify="flex-end">
      <Button onClick={onChoose}>{text.changeBackend}</Button>
      <Button onClick={() => void bridge.openInBrowser()}>
        {text.openInBrowser}
      </Button>
      <Button onClick={() => void bridge.retryBackend()} type="primary">
        {text.retry}
      </Button>
    </Flexbox>
  </>
);

const BackendWindow = () => {
  const [info, setInfo] = useState<BackendInfo | null>(null);
  const [screen, setScreen] = useState<'choose' | 'unreachable'>('choose');

  useEffect(() => {
    // Everything the window shows comes from the main process: it owns the
    // strings, and it is the only half that knows which screen is due.
    void bridge.getInfo().then((next) => {
      setInfo(next);
      setScreen(next.screen ?? 'choose');
    });
  }, []);

  if (!info) {
    return null;
  }

  return (
    <LobeUiProvider initialTheme="dark">
      <Flexbox gap={16} padding={24} width="100%">
        {screen === 'unreachable' && info.unreachable ? (
          <Unreachable
            onChoose={() => setScreen('choose')}
            text={info.text}
            unreachable={info.unreachable}
          />
        ) : (
          <Choose backend={info.backend} text={info.text} />
        )}
      </Flexbox>
    </LobeUiProvider>
  );
};

const root = document.getElementById('root');

if (root) {
  createRoot(root).render(<BackendWindow />);
}
