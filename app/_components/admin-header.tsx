'use client';

import { Block, Button, Flexbox, Text } from '@lobehub/ui';
import { DropdownMenu, Select } from '@lobehub/ui/base-ui';
import { Languages, Menu, SunMoon } from 'lucide-react';
import type { ReactNode } from 'react';

import type { ThemeMode } from '@/app/admin/_components/admin-store';
import {
  locales,
  type LocalePreference,
  systemLocalePreference,
} from '@/lib/i18n/routing';

const localeLabels: Record<string, string> = {
  'en-US': 'English',
  'ja-JP': '日本語',
  'zh-CN': '简体中文',
};

interface AdminHeaderProps {
  action?: ReactNode;
  brand: string;
  className: string;
  locale: string;
  localePreference: LocalePreference;
  onLocaleChange: (locale: string) => void;
  onThemeChange: (theme: ThemeMode) => void;
  systemLocaleLabel: string;
  theme: ThemeMode;
  themeLabels: Record<ThemeMode, string>;
}

export const AdminHeader = ({
  action,
  brand,
  className,
  locale,
  onLocaleChange,
  onThemeChange,
  theme,
  themeLabels,
  localePreference,
  systemLocaleLabel,
}: AdminHeaderProps) => {
  return (
    <Block
      as="header"
      align="center"
      className={`admin-header ${className}`}
      distribution="space-between"
      horizontal
      variant="borderless"
    >
      <Text as="div" className="admin-header-brand" strong>
        {brand}
      </Text>
      <Flexbox
        align="center"
        className="admin-header-controls"
        gap={8}
        horizontal
      >
        <label className="admin-header-select">
          <Languages aria-hidden="true" size={16} strokeWidth={2} />
          <Select
            aria-label="Language"
            onChange={onLocaleChange}
            options={[
              { label: systemLocaleLabel, value: systemLocalePreference },
              ...locales.map((item) => ({
                label: localeLabels[item] ?? item,
                value: item,
              })),
            ]}
            value={localePreference}
          />
        </label>
        <label className="admin-header-select">
          <SunMoon aria-hidden="true" size={16} strokeWidth={2} />
          <Select
            aria-label="Theme mode"
            onChange={(value) => onThemeChange(value as ThemeMode)}
            options={[
              { label: themeLabels.light, value: 'light' },
              { label: themeLabels.dark, value: 'dark' },
              { label: themeLabels.system, value: 'system' },
            ]}
            value={theme}
          />
        </label>
        {action}
      </Flexbox>
      <div className="admin-header-mobile-menu">
        <DropdownMenu
          items={[
            {
              children: [
                {
                  key: systemLocalePreference,
                  label: systemLocaleLabel,
                  onClick: () => onLocaleChange(systemLocalePreference),
                },
                ...locales.map((item) => ({
                  key: item,
                  label: localeLabels[item] ?? item,
                  onClick: () => onLocaleChange(item),
                })),
              ],
              icon: Languages,
              key: 'locale',
              label:
                localePreference === systemLocalePreference
                  ? systemLocaleLabel
                  : (localeLabels[localePreference] ?? locale),
              type: 'submenu',
            },
            {
              children: [
                {
                  key: 'light',
                  label: themeLabels.light,
                  onClick: () => onThemeChange('light'),
                },
                {
                  key: 'dark',
                  label: themeLabels.dark,
                  onClick: () => onThemeChange('dark'),
                },
                {
                  key: 'system',
                  label: themeLabels.system,
                  onClick: () => onThemeChange('system'),
                },
              ],
              icon: SunMoon,
              key: 'theme',
              label: themeLabels[theme],
              type: 'submenu',
            },
          ]}
          footer={action ?? undefined}
          nativeButton
          placement="bottomRight"
        >
          <Button aria-label="Console menu" icon={Menu} />
        </DropdownMenu>
      </div>
    </Block>
  );
};
