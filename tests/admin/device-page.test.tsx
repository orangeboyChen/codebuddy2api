// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConfigProvider } from '@lobehub/ui';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import DeviceClient from '@/app/device/device-client';
import { configProviderMotion } from '@/lib/client/motion';
import { getMessages } from '@/lib/i18n/messages';

/**
 * The page a device sends the user to, which is where the sign-in is approved.
 *
 * What this covers is the one thing the page is for: the code the app showed is
 * the code this page sends, pressed the way a user presses it. A button that
 * submits nothing leaves the device waiting for an approval that was never
 * asked for — which is exactly what it did, and why the press is what is tested
 * rather than the handler.
 */
const messages = getMessages('en-US');

/**
 * What the browser will answer with, and what it was asked.
 *
 * Only the approval is scripted: the page also saves the appearance it is
 * shown in, and an answer that fails for everything would fail that too, which
 * is a different thing failing from the one being tested.
 */
const requests: Array<{ body: string; url: string }> = [];

const stubFetch = (status: number): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { body: string }) => {
      const approving = url.includes('/admin-api/oauth/device/approve');

      if (approving) {
        requests.push({ body: init.body, url });
      }

      return new Response(null, {
        status: approving ? status : 200,
      });
    }),
  );
};

/**
 * What jsdom does not have and a browser does: the appearance the computer is
 * in, which the theme provider listens to for changes to.
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

const renderPage = (userCode = 'ABCD-EFGH') => {
  stubMatchMedia();

  return render(
    <ConfigProvider motion={configProviderMotion}>
      <NextIntlClientProvider locale="en-US" messages={messages}>
        <DeviceClient
          initialTheme="light"
          initialUserCode={userCode}
          locale="en-US"
          localePreference="en-US"
          translations={messages.Admin.devicePage}
        />
      </NextIntlClientProvider>
    </ConfigProvider>,
  );
};

beforeEach(() => {
  requests.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the page a device sends the user to', () => {
  it('asks for the code the device is showing, and sends it when pressed', async () => {
    stubFetch(200);
    renderPage();

    const field = screen.getByLabelText('Code') as HTMLInputElement;

    // The code came in the link the app opened, so it is already in the box:
    // a user is not asked to copy a number off a dialog.
    expect(field.value).toBe('ABCD-EFGH');

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });

    expect(requests[0]?.url).toBe('/admin-api/oauth/device/approve');
    expect(JSON.parse(requests[0]?.body ?? '{}')).toEqual({
      user_code: 'ABCD-EFGH',
    });

    expect(await screen.findByText('Device approved')).toBeTruthy();
  });

  it('says so when the code is not one this console is waiting for', async () => {
    stubFetch(404);
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    expect(
      await screen.findByText(
        'That code is not one this console is waiting for, or it has run out.',
      ),
    ).toBeTruthy();
    // Nothing approved, so the page is still asking: the device is still
    // waiting, and the user can try the code again.
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
  });

  it('says so when the approval failed for any other reason', async () => {
    stubFetch(500);
    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    expect(await screen.findByText('Approval failed. Try again.')).toBeTruthy();
  });

  it('has nothing to send out of an empty code', () => {
    stubFetch(200);
    renderPage('');

    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(requests).toHaveLength(0);
  });
});
