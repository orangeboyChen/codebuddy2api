'use client';

import { Block, Flexbox, Input, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { useAtom } from 'jotai';
import { useHydrateAtoms } from 'jotai/utils';
import { useState, useTransition } from 'react';

import { AdminHeader } from '@/app/header';
import { themeAtom } from '@/app/page-state';
import { saveLocalePreference } from '@/lib/client/preferences';
import { useThemeAppearance } from '@/lib/client/theme';
import type { AdminDeviceMessages } from '@/lib/i18n/messages';
import { type LocalePreference } from '@/lib/i18n/routing';
import type { ThemeMode } from '@/lib/theme';

interface DeviceClientProps {
  /** The code the device showed, when the link carried it. */
  initialUserCode?: string;
  initialTheme?: ThemeMode;
  locale: string;
  localePreference?: LocalePreference;
  translations: AdminDeviceMessages;
}

/**
 * The page a device sends the user to.
 *
 * It asks for nothing but the code the device is showing, and the sign-in it
 * sits behind is this console's own — which is the whole reason the app sends
 * people here instead of asking for a password in its window: a passkey is bound
 * to this address, so it is a passkey that works here and would not work there.
 */
const DeviceClient = ({
  initialUserCode = '',
  initialTheme = 'system',
  locale,
  localePreference,
  translations,
}: DeviceClientProps) => {
  useHydrateAtoms([[themeAtom, initialTheme]]);
  const [theme, setTheme] = useAtom(themeAtom);
  useThemeAppearance(theme);
  const [userCode, setUserCode] = useState(initialUserCode);
  const [approved, setApproved] = useState(false);
  const [error, setError] = useState('');
  const [isPending, startTransition] = useTransition();

  const changeLocale = (nextLocale: string): void => {
    void saveLocalePreference(nextLocale as LocalePreference).finally(() => {
      window.location.reload();
    });
  };

  const approve = async (): Promise<void> => {
    setError('');

    try {
      const response = await fetch('/admin-api/oauth/device/approve', {
        body: JSON.stringify({ user_code: userCode }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });

      if (!response.ok) {
        setError(
          response.status === 404 ? translations.notFound : translations.failed,
        );

        return;
      }

      setApproved(true);
    } catch {
      setError(translations.failed);
    }
  };

  return (
    <Flexbox
      align="center"
      as="main"
      className="login-page"
      distribution="center"
    >
      <AdminHeader
        brand="CodeBuddy2API"
        className="login-header"
        localePreference={localePreference ?? (locale as LocalePreference)}
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
            {approved ? translations.approvedHeading : translations.heading}
          </Text>
          <Text type="secondary">
            {approved ? translations.approved : translations.description}
          </Text>
        </Flexbox>

        {approved ? null : (
          <Flexbox
            as="form"
            direction="vertical"
            gap={12}
            onSubmit={(event) => {
              event.preventDefault();
              startTransition(() => {
                void approve();
              });
            }}
          >
            <label htmlFor="device-user-code">
              <Text weight={500}>{translations.codeLabel}</Text>
            </label>
            <Input
              autoCapitalize="characters"
              autoComplete="off"
              id="device-user-code"
              name="user_code"
              onChange={(event) => {
                setUserCode(event.target.value);
              }}
              value={userCode}
            />
            <Button
              disabled={isPending || !userCode.trim()}
              // The form's own: without it the button is `type="button"`, and
              // pressing it submits nothing — the code is never sent, and the
              // device waits for an approval this page never asked for.
              htmlType="submit"
              loading={isPending}
              type="primary"
            >
              {isPending ? translations.submitting : translations.submit}
            </Button>
          </Flexbox>
        )}

        {error ? <Text type="danger">{error}</Text> : null}
      </Block>
    </Flexbox>
  );
};

export default DeviceClient;
