import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

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

interface ChooseProps {
  backend: DesktopBackend;
  text: DesktopText;
}

const Choose = ({ backend, text }: ChooseProps) => {
  const [mode, setMode] = useState<'local' | 'remote'>(backend.mode);
  const [url, setUrl] = useState(backend.mode === 'remote' ? backend.url : '');
  const [error, setError] = useState('');
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
            setError('');
            setMode('local');
          }}
          value="local"
        />
        <Option
          checked={mode === 'remote'}
          hint={text.backendRemoteHint}
          label={text.backendRemote}
          onChange={() => {
            setError('');
            setMode('remote');
          }}
          value="remote"
        />
      </fieldset>
      <input
        disabled={mode !== 'remote'}
        id="url"
        onChange={(event) => {
          setError('');
          setUrl(event.target.value);
        }}
        placeholder={text.backendUrlPlaceholder}
        ref={field}
        type="text"
        value={url}
      />
      {error ? <p className="error">{error}</p> : null}
      <div className="buttons">
        {/* Closing without answering leaves the app on the backend it was
            already using — or on the local gateway, on a first launch. */}
        <button onClick={() => window.close()} type="button">
          {text.cancel}
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

const BackendWindow = () => {
  const [info, setInfo] = useState<BackendInfo | null>(null);
  const [screen, setScreen] = useState<'choose' | 'unreachable'>('choose');
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
      ) : (
        <Choose backend={info.backend} text={info.text} />
      )}
    </div>
  );
};

const root = document.getElementById('root');

if (root) {
  createRoot(root).render(<BackendWindow />);
}
