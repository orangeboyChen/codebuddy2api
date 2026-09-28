import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Radio } from 'antd';
import {
  Button,
  ConfigProvider,
  Input,
  Tabs,
  ThemeProvider,
} from '@lobehub/ui';

import { configProviderMotion } from '@/lib/client/motion';
import { fillText, type DesktopText } from '@/lib/server/electron/desktop-text';
import type { DesktopBackend } from '@/lib/server/electron/settings';

interface BackendInfo {
  appVersion: string;
  backend: DesktopBackend;
  /**
   * True until a backend has been chosen. A first launch has no answer on disk,
   * and closing the window then quits the app rather than guessing one.
   */
  firstRun: boolean;
  /** Where this app lives: opened in the browser from the About tab. */
  homePage: string;
  locale: string;
  /** The bounds the port field is checked against, from the main process. */
  maxPort: number;
  minPort: number;
  /** The port the app would serve on: the one saved, or the default. */
  port: number;
  portInUse?: { message: string; port: string } | null;
  /** Absent from a main process that only ever had the one screen. */
  screen?: 'choose' | 'portInUse' | 'settings' | 'unreachable';
  /** Only a backend that is not this app has a version of its own. */
  serverVersion?: string | null;
  text: DesktopText;
  unreachable?: { host: string; message: string } | null;
}

interface DesktopBridge {
  getInfo: () => Promise<BackendInfo>;
  openInBrowser: () => Promise<void>;
  /** The page the app lives on, in the system browser. */
  openHomePage: () => Promise<void>;
  retryBackend: () => Promise<void>;
  // Everything the window can settle in one call: a backend alone would save
  // the port it never asked about.
  setBackend: (choice: {
    backend: DesktopBackend;
    port?: number;
  }) => Promise<void>;
  setContentSize: (width: number, height: number) => Promise<void>;
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

/**
 * The port the app would bind, or null when the field does not hold one.
 *
 * Nothing but digits counts, because a number is what the gateway binds — the
 * same rule the main process applies to a saved setting. The bounds come from
 * it too, so a port it would refuse is refused here as well.
 */
const parsePort = (
  value: string,
  minPort: number,
  maxPort: number,
): number | null => {
  const trimmed = value.trim();

  if (!/^\d{1,5}$/.test(trimmed)) {
    return null;
  }

  const parsed = Number.parseInt(trimmed, 10);

  return parsed >= minPort && parsed <= maxPort ? parsed : null;
};

/**
 * What to say when the field does not hold a port the app could bind. The
 * bounds are named in it, and they are the main process's, so they are not
 * written here.
 */
const invalidPort = (text: DesktopText, minPort: number, maxPort: number) =>
  fillText(text.invalidPort, { max: String(maxPort), min: String(minPort) });

/**
 * Asks the main process for a window the size of the pane.
 *
 * The strings are the main process's own, but only this page knows how much
 * room they took: a hint that fits on one line in English runs to three in
 * Japanese, and the font is the computer's to choose. The pane is `width:
 * max-content`, so what gets measured is the width the text wants rather than
 * whatever is left over in a window that has not been sized yet — and the pane
 * is watched rather than measured once, because an answer that turns out to be
 * wrong grows it: an error under the field, the other screen.
 */
const useFitWindow = (pane: HTMLDivElement | null): void => {
  useEffect(() => {
    if (!pane) {
      return;
    }

    const fit = (): void => {
      const { height, width } = pane.getBoundingClientRect();

      void bridge.setContentSize(Math.ceil(width), Math.ceil(height));
    };

    fit();

    const observer = new ResizeObserver(fit);

    observer.observe(pane);

    return () => {
      observer.disconnect();
    };
  }, [pane]);
};

/** Escape closes the window, which is what it does in every other dialog. */
const useCloseOnEscape = (): void => {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        window.close();
      }
    };

    window.addEventListener('keydown', onKeyDown);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);
};

interface OptionProps {
  checked: boolean;
  hint: string;
  label: string;
  onChange: () => void;
  value: string;
}

const Option = ({ checked, hint, label, onChange, value }: OptionProps) => (
  <label className="option">
    <input
      checked={checked}
      name="backend"
      onChange={onChange}
      type="radio"
      value={value}
    />
    <span>
      <strong>{label}</strong>
      <span className="hint">{hint}</span>
    </span>
  </label>
);

interface PortFieldProps {
  error?: string;
  onChange: (value: string) => void;
  text: DesktopText;
  value: string;
}

/**
 * The port the app serves its own console and API on. Only the local gateway is
 * served on a port of this machine's: a deployment is reached through its
 * address, so naming one leaves the saved number standing.
 */
const PortField = ({ error, onChange, text, value }: PortFieldProps) => (
  <div className="field">
    <label htmlFor="port">{text.port}</label>
    <input
      id="port"
      inputMode="numeric"
      maxLength={5}
      onChange={(event) => onChange(event.target.value)}
      type="text"
      value={value}
    />
    <span className="hint">{text.portHint}</span>
    {error ? <p className="error">{error}</p> : null}
  </div>
);

interface ChooseProps {
  backend: DesktopBackend;
  firstRun: boolean;
  maxPort: number;
  minPort: number;
  port: number;
  text: DesktopText;
}

const Choose = ({
  backend,
  firstRun,
  maxPort,
  minPort,
  port,
  text,
}: ChooseProps) => {
  const [mode, setMode] = useState<'local' | 'remote'>(backend.mode);
  const [url, setUrl] = useState(backend.mode === 'remote' ? backend.url : '');
  const [urlError, setUrlError] = useState('');
  const [portValue, setPortValue] = useState(String(port));
  const [portError, setPortError] = useState('');
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Naming a deployment is a decision to type its address, so the caret
    // belongs in the field rather than waiting for a click.
    if (mode === 'remote') {
      field.current?.focus();
    }
  }, [mode]);

  const save = () => {
    if (mode === 'local') {
      const nextPort = parsePort(portValue, minPort, maxPort);

      if (!nextPort) {
        setPortError(invalidPort(text, minPort, maxPort));

        return;
      }

      void bridge.setBackend({ backend: { mode: 'local' }, port: nextPort });

      return;
    }

    const parsed = parseUrl(url);

    if (!parsed) {
      setUrlError(text.invalidBackendUrl);

      return;
    }

    // A deployment is reached through its address, so nothing on this machine
    // is being settled: the port the console is served on is the one already
    // saved, and the main process leaves it standing.
    void bridge.setBackend({ backend: { mode: 'remote', url: parsed } });
  };

  return (
    <form
      className="stack"
      onSubmit={(event) => {
        // Enter presses the button it would press in any other dialog, instead
        // of submitting a page that has nowhere to go.
        event.preventDefault();
        save();
      }}
    >
      <h1 id="title">{text.chooseBackend}</h1>
      <fieldset className="options">
        <Option
          checked={mode === 'local'}
          hint={text.backendLocalHint}
          label={text.backendLocal}
          onChange={() => {
            setUrlError('');
            setMode('local');
          }}
          value="local"
        />
        <Option
          checked={mode === 'remote'}
          hint={text.backendRemoteHint}
          label={text.backendRemote}
          onChange={() => {
            setUrlError('');
            setMode('remote');
          }}
          value="remote"
        />
      </fieldset>
      <div className="field">
        <input
          disabled={mode !== 'remote'}
          id="url"
          onChange={(event) => {
            setUrlError('');
            setUrl(event.target.value);
          }}
          placeholder={text.backendUrlPlaceholder}
          ref={field}
          type="text"
          value={url}
        />
        {urlError ? <p className="error">{urlError}</p> : null}
      </div>
      {/*
        Only this machine's gateway is served on a port of this machine's: with
        a deployment named, the address is the whole answer and the port stays
        the one already saved.
      */}
      {mode === 'local' ? (
        <PortField
          error={portError}
          onChange={(value) => {
            setPortError('');
            setPortValue(value);
          }}
          text={text}
          value={portValue}
        />
      ) : null}
      <div className="buttons">
        {/*
          A first launch that gets no answer quits: the app has nothing else to
          start, and no gateway to keep running. Later, closing leaves the
          backend and the port already in use alone.
        */}
        <button onClick={() => window.close()} type="button">
          {firstRun ? text.quit : text.cancel}
        </button>
        <button className="primary" id="save" type="submit">
          {text.save}
        </button>
      </div>
    </form>
  );
};

interface SettingsProps {
  backend: DesktopBackend;
  info: BackendInfo;
  maxPort: number;
  minPort: number;
  port: number;
  text: DesktopText;
}

/**
 * The settings: one tab view, two tabs.
 *
 * The backend the app shows data from — which is the question the shell used to
 * ask on its own — and what this app is. Saving is the Backend tab's own
 * button, the way the window's close button is the desktop's: nothing is asked
 * for from a tab it does not belong to.
 */
const Settings = ({
  backend,
  info,
  maxPort,
  minPort,
  port,
  text,
}: SettingsProps) => {
  const [mode, setMode] = useState<'local' | 'remote'>(backend.mode);
  const [url, setUrl] = useState(backend.mode === 'remote' ? backend.url : '');
  const [portValue, setPortValue] = useState(String(port));
  const [error, setError] = useState('');

  const save = () => {
    if (mode === 'local') {
      const nextPort = parsePort(portValue, minPort, maxPort);

      if (!nextPort) {
        setError(invalidPort(text, minPort, maxPort));

        return;
      }

      void bridge.setBackend({ backend: { mode: 'local' }, port: nextPort });

      return;
    }

    const parsed = parseUrl(url);

    if (!parsed) {
      setError(text.invalidBackendUrl);

      return;
    }

    // A deployment is reached through its address, so nothing on this machine
    // is being settled: the port the console is served on is the one already
    // saved, and the main process leaves it standing.
    void bridge.setBackend({ backend: { mode: 'remote', url: parsed } });
  };

  return (
    <Tabs
      items={[
        {
          children: (
            <form
              className="stack"
              onSubmit={(event) => {
                // Enter presses the button it would press in any other dialog,
                // instead of submitting a page that has nowhere to go.
                event.preventDefault();
                save();
              }}
            >
              <Radio.Group
                onChange={(event) => {
                  setError('');
                  setMode(event.target.value);
                }}
                value={mode}
              >
                <fieldset className="options">
                  <label className="option">
                    <Radio value="local" />
                    <span>
                      <strong>{text.backendLocal}</strong>
                      <span className="hint">{text.backendLocalHint}</span>
                    </span>
                  </label>
                  <label className="option">
                    <Radio value="remote" />
                    <span>
                      <strong>{text.backendRemote}</strong>
                      <span className="hint">{text.backendRemoteHint}</span>
                    </span>
                  </label>
                </fieldset>
              </Radio.Group>
              {/*
                The port belongs to this machine and the address to a
                deployment: each is asked for only while its own option is the
                one picked.
              */}
              {mode === 'remote' ? (
                <div className="field">
                  <label htmlFor="url">{text.address}</label>
                  <Input
                    id="url"
                    onChange={(event) => {
                      setError('');
                      setUrl(event.target.value);
                    }}
                    placeholder={text.backendUrlPlaceholder}
                    value={url}
                  />
                  <span className="hint">{text.backendRemoteHint}</span>
                </div>
              ) : (
                <PortField
                  onChange={(value) => {
                    setError('');
                    setPortValue(value);
                  }}
                  text={text}
                  value={portValue}
                />
              )}
              {error ? <p className="error">{error}</p> : null}
              <div className="buttons">
                <button
                  className="primary"
                  id="save"
                  onClick={() => save()}
                  type="button"
                >
                  {text.save}
                </button>
              </div>
            </form>
          ),
          key: 'backend',
          label: text.settingsTabBackend,
        },
        {
          children: (
            <div className="stack">
              <p className="message">
                {fillText(text.appVersion, { version: info.appVersion })}
              </p>
              <p className="message">
                {`${text.backend}: ${backend.mode === 'remote' ? text.backendRemote : text.backendLocal}`}
              </p>
              {info.serverVersion ? (
                <p className="message">
                  {fillText(text.serverVersion, {
                    version: info.serverVersion,
                  })}
                </p>
              ) : null}
              <div className="buttons">
                <Button
                  htmlType="button"
                  onClick={() => void bridge.openHomePage()}
                >
                  {info.homePage.replace(/^https?:\/\//, '')}
                </Button>
              </div>
            </div>
          ),
          key: 'about',
          label: text.settingsTabAbout,
        },
      ]}
    />
  );
};

interface PortInUseProps {
  backend: DesktopBackend;
  maxPort: number;
  minPort: number;
  portInUse: { message: string; port: string };
  text: DesktopText;
}

/**
 * The port the app was asked for and could not have: something on this machine
 * is already serving it. The number is the one thing to settle, so the field is
 * here rather than a screen away — and "Try again" is for a port that was freed
 * while this window was open.
 */
const PortInUse = ({
  backend,
  maxPort,
  minPort,
  portInUse,
  text,
}: PortInUseProps) => {
  const [port, setPort] = useState(portInUse.port);
  const [error, setError] = useState('');
  const [retrying, setRetrying] = useState(false);

  const save = () => {
    const nextPort = parsePort(port, minPort, maxPort);

    if (!nextPort) {
      setError(invalidPort(text, minPort, maxPort));

      return;
    }

    void bridge.setBackend({ backend, port: nextPort });
  };

  const retry = async () => {
    setRetrying(true);
    await bridge.retryBackend();
    setRetrying(false);
  };

  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <h1 id="portInUse">
        {fillText(text.portInUseTitle, { port: portInUse.port })}
      </h1>
      {/* The main process already filled the port into this one. */}
      <p className="message">{portInUse.message}</p>
      <PortField
        error={error}
        onChange={(value) => {
          setError('');
          setPort(value);
        }}
        text={text}
        value={port}
      />
      <div className="buttons">
        <button disabled={retrying} onClick={() => void retry()} type="button">
          {text.retry}
        </button>
        <button className="primary" id="save" type="submit">
          {text.save}
        </button>
      </div>
    </form>
  );
};

interface UnreachableProps {
  onChoose: () => void;
  text: DesktopText;
  unreachable: { host: string; message: string };
}

const Unreachable = ({ onChoose, text, unreachable }: UnreachableProps) => (
  <div className="stack">
    <h1>{text.unreachableTitle}</h1>
    {/* The main process already filled the host into this one. */}
    <p className="message">{unreachable.message}</p>
    <div className="buttons">
      <button onClick={onChoose} type="button">
        {text.changeBackend}
      </button>
      <button onClick={() => void bridge.openInBrowser()} type="button">
        {text.openInBrowser}
      </button>
      <button
        className="primary"
        onClick={() => void bridge.retryBackend()}
        type="button"
      >
        {text.retry}
      </button>
    </div>
  </div>
);

/**
 * The appearance the computer is in, which is the one this window is drawn in.
 *
 * The window is dressed by the computer and not by the app, so it follows the
 * appearance setting instead of keeping one of its own: a dark desktop gets a
 * dark settings window, whatever the console behind it was last left in.
 */
const systemAppearance = (): 'dark' | 'light' =>
  window.matchMedia?.('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';

export const BackendWindow = () => {
  const [info, setInfo] = useState<BackendInfo | null>(null);
  const [screen, setScreen] = useState<
    'choose' | 'portInUse' | 'settings' | 'unreachable'
  >('choose');
  // The pane, once there is one: only then is there anything to measure, which
  // is after the main process has answered with something to render.
  const [pane, setPane] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    // Everything the window shows comes from the main process: it owns the
    // strings, and it is the only half that knows which screen is due.
    void bridge.getInfo().then((next) => {
      setInfo(next);
      setScreen(next.screen ?? 'choose');
    });
  }, []);

  useFitWindow(pane);
  useCloseOnEscape();

  if (!info) {
    return null;
  }

  return (
    <div id="pane" ref={setPane}>
      {screen === 'unreachable' && info.unreachable ? (
        <Unreachable
          onChoose={() => setScreen('choose')}
          text={info.text}
          unreachable={info.unreachable}
        />
      ) : screen === 'settings' ? (
        <Settings
          backend={info.backend}
          info={info}
          maxPort={info.maxPort}
          minPort={info.minPort}
          port={info.port}
          text={info.text}
        />
      ) : screen === 'portInUse' && info.portInUse ? (
        <PortInUse
          backend={info.backend}
          maxPort={info.maxPort}
          minPort={info.minPort}
          portInUse={info.portInUse}
          text={info.text}
        />
      ) : (
        <Choose
          backend={info.backend}
          firstRun={info.firstRun}
          maxPort={info.maxPort}
          minPort={info.minPort}
          port={info.port}
          text={info.text}
        />
      )}
    </div>
  );
};

const root = document.getElementById('root');

if (root) {
  // `ConfigProvider` is what `Tabs` reads its motion from, and it throws
  // without one — which took the whole tree down and left the window blank.
  // `ThemeProvider` is what gives the controls the appearance the computer is
  // in; `enableGlobalStyle` is off because this page is dressed by the
  // stylesheet in `backend.html`, not by the console's.
  createRoot(root).render(
    <ConfigProvider motion={configProviderMotion}>
      <ThemeProvider
        appearance={systemAppearance()}
        enableCustomFonts={false}
        enableGlobalStyle={false}
      >
        <BackendWindow />
      </ThemeProvider>
    </ConfigProvider>,
  );
}
