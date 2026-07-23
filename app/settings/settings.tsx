'use client';

import { Block, Flexbox, Input, TextArea } from '@lobehub/ui';
import { Button, Select } from '@lobehub/ui/base-ui';
import { Table } from 'antd';
import type { TableColumnsType } from 'antd';
import { atom } from 'jotai';
import {
  Layers3,
  LoaderCircle,
  RefreshCw,
  Save,
  Server,
  Trash2,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { createContext, useContext, useEffect, useRef, useState } from 'react';

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

interface CredentialModelResponse {
  models?: Record<
    string,
    { error?: string | null; models?: Array<{ id?: string }> }
  >;
}

interface CredentialModelRow {
  error: string | null;
  filename: string;
  models: string[];
  modelsInput: string;
}

const toCredentialModelRows = (
  payload: CredentialModelResponse,
): CredentialModelRow[] => {
  return Object.entries(payload.models ?? {}).map(([filename, value]) => ({
    error: value.error ?? null,
    filename,
    models: (value.models ?? [])
      .map((model) => model.id)
      .filter((model): model is string => Boolean(model)),
    modelsInput: (value.models ?? [])
      .map((model) => model.id)
      .filter((model): model is string => Boolean(model))
      .join(', '),
  }));
};

const parseSupportedModels = (value: string): string[] => {
  return value
    .split(/[\n,]/)
    .map((model) => model.trim())
    .filter(Boolean);
};

const CredentialModels = () => {
  const common = useTranslations('Admin.common');
  const credentialsText = useTranslations('Admin.credentials');
  const [loading, setLoading] = useState(true);
  const [refreshingFilename, setRefreshingFilename] = useState<string | null>(
    null,
  );
  const [savingFilename, setSavingFilename] = useState<string | null>(null);
  const [rows, setRows] = useState<CredentialModelRow[]>([]);
  const saveTimersRef = useRef(new Map<string, number>());

  const refresh = async (filename: string) => {
    setRefreshingFilename(filename);

    try {
      const response = await fetch('/admin-api/credentials/models', {
        body: JSON.stringify({ filename }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });
      const row = toCredentialModelRows(
        (await response.json()) as CredentialModelResponse,
      )[0];

      if (!row) return;

      setRows((current) =>
        current.map((item) => (item.filename === filename ? row : item)),
      );
    } finally {
      setRefreshingFilename(null);
    }
  };

  const updateModels = (filename: string, value: string) => {
    const models = parseSupportedModels(value);
    setRows((current) =>
      current.map((row) =>
        row.filename === filename
          ? { ...row, models, modelsInput: value }
          : row,
      ),
    );
  };

  const saveModels = async (filename: string, models: string[]) => {
    setSavingFilename(filename);

    try {
      const response = await fetch('/admin-api/credentials/models', {
        body: JSON.stringify({ filename, models: models.join(', ') }),
        headers: { 'Content-Type': 'application/json' },
        method: 'PUT',
      });

      if (!response.ok) {
        throw new Error('Unable to save supported models');
      }
    } finally {
      setSavingFilename(null);
    }
  };

  const scheduleSave = (filename: string, value: string) => {
    const existingTimer = saveTimersRef.current.get(filename);
    if (existingTimer) window.clearTimeout(existingTimer);

    saveTimersRef.current.set(
      filename,
      window.setTimeout(() => {
        saveTimersRef.current.delete(filename);
        void saveModels(filename, parseSupportedModels(value));
      }, 500),
    );
  };

  const saveImmediately = (filename: string, value: string) => {
    const existingTimer = saveTimersRef.current.get(filename);
    if (existingTimer) window.clearTimeout(existingTimer);
    saveTimersRef.current.delete(filename);
    void saveModels(filename, parseSupportedModels(value));
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void (async () => {
        setLoading(true);

        try {
          const response = await fetch('/admin-api/credentials/models');
          setRows(
            toCredentialModelRows(
              (await response.json()) as CredentialModelResponse,
            ),
          );
        } finally {
          setLoading(false);
        }
      })();
    }, 0);

    return () => {
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(
    () => () => {
      saveTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      saveTimersRef.current.clear();
    },
    [],
  );

  const columns: TableColumnsType<CredentialModelRow> = [
    {
      dataIndex: 'filename',
      key: 'filename',
      title: credentialsText('modelCredential'),
      width: 220,
    },
    {
      key: 'models',
      render: (_, row) =>
        row.error ? (
          row.error
        ) : (
          <TextArea
            className="credential-models-input"
            disabled={savingFilename === row.filename}
            onBlur={(event) =>
              saveImmediately(row.filename, event.currentTarget.value)
            }
            onChange={(event) => {
              updateModels(row.filename, event.target.value);
              scheduleSave(row.filename, event.target.value);
            }}
            rows={3}
            value={row.modelsInput}
          />
        ),
      title: credentialsText('modelSupported'),
      minWidth: 360,
    },
    {
      key: 'refresh',
      render: (_, row) => (
        <Button
          icon={RefreshCw}
          loading={refreshingFilename === row.filename}
          onClick={() => void refresh(row.filename)}
        >
          {common('refresh')}
        </Button>
      ),
      title: credentialsText('modelRefresh'),
      width: 130,
    },
  ];

  return (
    <Block
      className="min-w-0 max-w-full"
      direction="vertical"
      gap={16}
      padding={24}
      variant="outlined"
    >
      <Flexbox align="center" gap={8} horizontal>
        <Layers3 size={18} strokeWidth={2} />
        <h3 className="section-title">{credentialsText('modelTableTitle')}</h3>
      </Flexbox>
      <div className="credential-models-table w-full min-w-0 max-w-full">
        <Table<CredentialModelRow>
          columns={columns}
          dataSource={rows}
          loading={loading}
          pagination={false}
          rowKey="filename"
          scroll={{ x: 'max-content' }}
          size="middle"
        />
      </div>
    </Block>
  );
};

const Settings = () => {
  const { onChange, onSave, settings } = useSettings();
  const translations = useTranslations('Admin');
  const [clearingUsage, setClearingUsage] = useState(false);

  const clearUsageEvents = async () => {
    if (
      !window.confirm(translations('settingsPanel.confirmClearUsageEvents'))
    ) {
      return;
    }

    setClearingUsage(true);

    try {
      await fetch('/admin-api/usage/clear', { method: 'POST' });
    } finally {
      setClearingUsage(false);
    }
  };

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
      <CredentialModels />
      <Block direction="vertical" gap={16} padding={24} variant="outlined">
        <Flexbox align="center" gap={8} horizontal>
          <Trash2 size={18} strokeWidth={2} />
          <h3 className="section-title">
            {translations('settingsPanel.usageCacheTitle')}
          </h3>
        </Flexbox>
        <p className="text-secondary">
          {translations('settingsPanel.usageCacheDescription')}
        </p>
        <Flexbox horizontal>
          <Button
            danger
            disabled={clearingUsage}
            icon={Trash2}
            loading={clearingUsage}
            onClick={() => void clearUsageEvents()}
          >
            {translations('settingsPanel.clearUsageEvents')}
          </Button>
        </Flexbox>
      </Block>
      <Security />
    </div>
  );
};

export default Settings;
