'use client';

import { Block, Flexbox, Select, Text } from '@lobehub/ui';
import { Languages, Monitor, Moon, Sun } from 'lucide-react';
import type { ReactNode } from 'react';

import type { ThemeMode } from '@/app/admin/_components/admin-store';
import { locales } from '@/lib/i18n/routing';

interface AdminHeaderProps {
  action?: ReactNode;
  brand: string;
  className: string;
  locale: string;
  onLocaleChange: (locale: string) => void;
  onThemeChange: (theme: ThemeMode) => void;
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
}: AdminHeaderProps) => {
  const ThemeIcon = theme === 'dark' ? Moon : theme === 'light' ? Sun : Monitor;

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
            options={locales.map((item) => ({ label: item, value: item }))}
            value={locale}
          />
        </label>
        <label className="admin-header-select">
          <ThemeIcon aria-hidden="true" size={16} strokeWidth={2} />
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
    </Block>
  );
};
