'use client';

import { Block, Flexbox, Input, TextArea } from '@lobehub/ui';
import { Button, Select } from '@lobehub/ui/base-ui';
import { atom } from 'jotai';
import { LoaderCircle, Save, Server } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { createContext, useContext } from 'react';

import Security from './security';

export type SettingsValue = string | number | null;

export interface SettingsState {
  labels: Record<string, string>;
  loading: boolean;
  saving: boolean;
  values: Record<string, SettingsValue>;
}

export const defaultSettingsState: SettingsState = {
  labels: {},
  loading: true,
  saving: false,
  values: {},
};

export const settingsStateAtom = atom<SettingsState>(defaultSettingsState);

export const createSettingsState = ({
  settings,
}: {
  settings: {
    labels: Record<string, string>;
    values: Record<string, SettingsValue>;
  };
}): SettingsState => {
  return {
    labels: settings.labels,
    loading: false,
    saving: false,
    values: settings.values,
  };
};

export interface SettingsController {
  onChange: (key: string, value: string) => void;
  onSave: () => void;
  settings: SettingsState;
}

const SettingsContext = createContext<SettingsController | null>(null);
export const SettingsProvider = SettingsContext.Provider;

const useSettings = (): SettingsController => {
  const controller = useContext(SettingsContext);
  if (!controller) throw new Error('Settings controller is unavailable');
  return controller;
};

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
  placeholder,
  settingKey,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  placeholder?: string;
  settingKey: string;
  value: string;
}) => {
  const selectOptions = settingsSelectOptions[settingKey];

  return (
    <div className="mb-4">
      <label
        className="mb-2 block whitespace-normal break-words font-medium text-text-light dark:text-text-dark"
        htmlFor={settingKey}
      >
        {label}
      </label>
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
          placeholder={placeholder}
          type="text"
          value={value}
        />
      )}
    </div>
  );
};

const Settings = () => {
  const { onChange, onSave, settings } = useSettings();
  const translations = useTranslations('Admin');

  return (
    <div className="block" id="settings">
      <Block direction="vertical" gap={16} padding={24} variant="outlined">
        <Flexbox align="center" gap={8} horizontal>
          <Server size={18} strokeWidth={2} />
          <h3 className="section-title">
            {translations('settingsPanel.title')}
          </h3>
        </Flexbox>
        <div id="settingsForm">
          {settings.loading ? (
            <div className="py-8 text-center text-secondary">
              <LoaderCircle />
              <div>{translations('settingsPanel.loading')}</div>
            </div>
          ) : (
            Object.entries(settings.labels).map(([settingKey, label]) => (
              <SettingField
                key={settingKey}
                label={label}
                onChange={(value) => onChange(settingKey, value)}
                placeholder={
                  settingKey === 'CODEBUDDY_ADMIN_PASSKEY_RP_ID'
                    ? translations('settingsPanel.passkeyRpIdPlaceholder')
                    : undefined
                }
                settingKey={settingKey}
                value={String(settings.values[settingKey] ?? '')}
              />
            ))
          )}
        </div>
        <Flexbox horizontal>
          <Button
            disabled={settings.saving}
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
