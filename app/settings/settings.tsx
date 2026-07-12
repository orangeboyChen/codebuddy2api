'use client';

import { Block, Flexbox, Input, TextArea } from '@lobehub/ui';
import { Button, Select } from '@lobehub/ui/base-ui';
import { LoaderCircle, Save, Server } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useSettingsTab } from '@/lib/client/console';

import Security from './security';

const settingsSelectOptions: Record<
  string,
  Array<{ label: string; value: string }>
> = {
  CODEBUDDY_AUTH_MODE: [
    { label: 'auto', value: 'auto' },
    { label: 'token', value: 'token' },
  ],
  CODEBUDDY_INTERNET_ENVIRONMENT: [
    { label: 'ioa', value: 'ioa' },
    { label: 'internal', value: 'internal' },
    { label: 'public', value: 'public' },
  ],
  CODEBUDDY_LOG_LEVEL: [
    { label: 'DEBUG', value: 'DEBUG' },
    { label: 'INFO', value: 'INFO' },
    { label: 'WARNING', value: 'WARNING' },
    { label: 'ERROR', value: 'ERROR' },
  ],
};

const SettingField = ({
  label,
  onChange,
  settingKey,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  settingKey: string;
  value: string;
}) => {
  const selectOptions = settingsSelectOptions[settingKey];

  return (
    <label className="grid gap-2 text-sm text-text-light dark:text-text-dark">
      <span className="font-medium">{label}</span>
      {selectOptions ? (
        <Select
          className="w-full"
          id={settingKey}
          onChange={onChange}
          options={selectOptions}
          value={value}
        />
      ) : settingKey === 'CODEBUDDY_MODELS' ? (
        <TextArea
          id={settingKey}
          onChange={(event) => onChange(event.target.value)}
          rows={6}
          value={value}
        />
      ) : (
        <Input
          id={settingKey}
          onChange={(event) => onChange(event.target.value)}
          type="text"
          value={value}
        />
      )}
    </label>
  );
};

const Settings = () => {
  const { onChange, onSave, settings } = useSettingsTab();
  const translations = useTranslations('Admin');

  return (
    <div className="grid gap-6" id="settings">
      <Block direction="vertical" gap={16} padding={24} variant="outlined">
        <Flexbox align="center" gap={8} horizontal>
          <Server aria-hidden="true" size={18} strokeWidth={2} />
          <h2 className="section-title">
            {translations('settingsPanel.title')}
          </h2>
        </Flexbox>
        <p className="text-sm text-secondary">
          {translations('settingsPanel.helper')}
        </p>
        {settings.loading ? (
          <Flexbox
            align="center"
            className="py-8 text-secondary"
            direction="vertical"
            gap={8}
          >
            <LoaderCircle
              aria-hidden="true"
              className="animate-spin"
              size={20}
            />
            <span>{translations('settingsPanel.loading')}</span>
          </Flexbox>
        ) : (
          <div className="grid gap-4">
            {Object.entries(settings.labels).map(([settingKey, label]) => (
              <SettingField
                key={settingKey}
                label={label}
                onChange={(value) => onChange(settingKey, value)}
                settingKey={settingKey}
                value={String(settings.values[settingKey] ?? '')}
              />
            ))}
          </div>
        )}
        <Flexbox horizontal>
          <Button
            disabled={settings.saving}
            htmlType="button"
            icon={Save}
            loading={settings.saving}
            onClick={onSave}
            type="primary"
          >
            {translations('common.save')}
          </Button>
        </Flexbox>
      </Block>
      <Security />
    </div>
  );
};

export default Settings;
