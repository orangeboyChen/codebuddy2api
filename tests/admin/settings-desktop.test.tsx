// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConfigProvider } from '@lobehub/ui';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';

import Settings, {
  createSettingsState,
  SettingsProvider,
  type SettingsState,
} from '@/app/settings/settings';
import { configProviderMotion } from '@/lib/client/motion';
import { getMessages } from '@/lib/i18n/messages';

vi.mock('@simplewebauthn/browser', () => ({
  browserSupportsWebAuthnAutofill: vi.fn(),
  startAuthentication: vi.fn(),
}));

/**
 * The settings page as the two kinds of install see it.
 *
 * A desktop install keeps its data on this machine, which decides what is worth
 * asking in it: an engine it cannot reach, a store there is only one of, and a
 * password for a door only this app opens. The page is rendered here the way
 * the server would — a state built from what it answered with — because what is
 * being tested is which fields it draws, not how they are filled.
 */
const settingsState = (): SettingsState =>
  createSettingsState({
    settings: {
      labels: {
        CODEBUDDY_WEB_FETCH_BACKEND: 'WebFetch 后端',
        CODEBUDDY_WEB_SEARCH_BACKEND: 'WebSearch 后端',
      },
      values: {
        CODEBUDDY_WEB_FETCH_BACKEND: 'codebuddy',
        CODEBUDDY_WEB_SEARCH_BACKEND: 'codebuddy',
      },
    },
  });

/** What `/admin-api/desktop` answers, which is what shows the panel at all. */
const stubDesktopApi = (payload: unknown): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(payload))),
  );
};

/**
 * What jsdom does not have and a browser does: the width of the window, which
 * antd's grid listens to for changes to.
 */
const stubMatchMedia = (): void => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      addEventListener: () => undefined,
      matches: false,
      removeEventListener: () => undefined,
    })),
  );
};

const renderSettings = (desktop: boolean) => {
  stubMatchMedia();
  stubDesktopApi({ desktop: false });

  return render(
    <ConfigProvider motion={configProviderMotion}>
      <NextIntlClientProvider locale="zh-CN" messages={getMessages('zh-CN')}>
        <SettingsProvider
          value={{
            onChange: vi.fn(),
            onSave: vi.fn(),
            settings: settingsState(),
          }}
        >
          <Settings desktop={desktop} />
        </SettingsProvider>
      </NextIntlClientProvider>
    </ConfigProvider>,
  );
};

/**
 * Opens a picker, which is where what it offers is to be read.
 *
 * The combobox opens on a press rather than on a click alone, so both are sent;
 * what it offers then lands in a portal at the end of the document.
 */
const openPicker = async (id: string): Promise<void> => {
  const picker = document.getElementById(id);

  expect(picker).not.toBeNull();
  fireEvent.mouseDown(picker as HTMLElement);
  fireEvent.click(picker as HTMLElement);
  await waitFor(() => {
    expect(screen.getAllByRole('option').length).toBeGreaterThan(0);
  });
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the settings of a desktop install', () => {
  it('asks nothing about web search', () => {
    renderSettings(true);

    // CodeBuddy is the only engine an install whose data is here can reach, so
    // there is no engine to choose between and no key of the user's to ask for.
    expect(document.querySelector('#CODEBUDDY_WEB_SEARCH_BACKEND')).toBeNull();
    expect(screen.queryByText('WebSearch 后端')).toBeNull();
  });

  it('offers only the backends a fetch from this machine can use', async () => {
    renderSettings(true);

    await openPicker('CODEBUDDY_WEB_FETCH_BACKEND');

    // CodeBuddy, and this server fetching the page itself — nothing that needs
    // a key, or a browser somewhere else, to answer.
    expect(
      await screen.findByRole('option', { name: 'CodeBuddy' }),
    ).toBeTruthy();
    expect(await screen.findByRole('option', { name: '本地' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Jina Reader' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'Browserable' })).toBeNull();
  });

  it('offers no choice of where its data is kept', async () => {
    stubMatchMedia();
    stubDesktopApi({
      desktop: true,
      port: 8001,
      preferredPort: 8001,
      storageBackend: 'sqlite',
    });

    render(
      <ConfigProvider motion={configProviderMotion}>
        <NextIntlClientProvider locale="zh-CN" messages={getMessages('zh-CN')}>
          <SettingsProvider
            value={{
              onChange: vi.fn(),
              onSave: vi.fn(),
              settings: settingsState(),
            }}
          >
            <Settings desktop />
          </SettingsProvider>
        </NextIntlClientProvider>
      </ConfigProvider>,
    );

    // This machine is the only place the data can be, so a menu with one
    // disabled entry in it is not a menu: the port is still asked for, the
    // store is not.
    expect(await screen.findByLabelText('本地端口')).toBeTruthy();
    expect(await screen.findByText('桌面应用')).toBeTruthy();
    expect(document.querySelector('#desktopStorageBackend')).toBeNull();
    expect(screen.queryByText('存储后端')).toBeNull();
  });
});

describe('the settings of a deployment', () => {
  it('asks about web search, engine by engine', async () => {
    renderSettings(false);

    await openPicker('CODEBUDDY_WEB_SEARCH_BACKEND');

    // A deployment is reachable from a network and is somebody's to configure,
    // so every engine is offered, and so is switching the tool off.
    expect(await screen.findByRole('option', { name: 'SearXNG' })).toBeTruthy();
    expect(
      await screen.findByRole('option', { name: 'CodeBuddy' }),
    ).toBeTruthy();
  });
});
