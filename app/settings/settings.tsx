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

import {
  BACKEND_CONFIG_KEYS,
  BACKEND_NONE,
  FETCH_BACKEND_CONFIG_KEYS,
  FETCH_BACKENDS,
  isBackendDisabled,
  normalizeFetchBackends,
  normalizeSearchBackend,
  SEARCH_BACKENDS,
  SEARCH_BACKEND_CONFIG_KEYS,
  serializeFetchBackends,
} from '@/lib/server/search/backends';

import Security from './security';

export type SettingsValue = string | number | boolean | null;

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

/**
 * Display names for the server-tool backends.
 *
 * Product names, not prose: they stay the same in every locale the way the
 * log-level values above do, which is why they are here rather than in
 * `messages/`.
 */
const SEARCH_BACKEND_LABELS: Record<string, string> = {
  bing: 'Bing',
  brave: 'Brave Search',
  codebuddy: 'CodeBuddy',
  duckduckgo: 'DuckDuckGo',
  exa: 'Exa',
  searxng: 'SearXNG',
  serper: 'Serper (Google)',
  tavily: 'Tavily',
};

const FETCH_BACKEND_LABELS: Record<string, string> = {
  browserable: 'Browserable',
  codebuddy: 'CodeBuddy',
  codebuddy2api: 'codebuddy2api (local fetch)',
  jina: 'Jina Reader',
};

/** Regions DuckDuckGo accepts, offered as `kl` values. */
const DUCKDUCKGO_REGIONS: Array<{ labelKey: string; value: string }> = [
  { labelKey: 'worldwide', value: 'wt-wt' },
  { labelKey: 'china', value: 'cn-zh' },
  { labelKey: 'unitedStates', value: 'us-en' },
  { labelKey: 'japan', value: 'jp-jp' },
  { labelKey: 'unitedKingdom', value: 'uk-en' },
  { labelKey: 'germany', value: 'de-de' },
];

const selectOptionsFor = (
  settingKey: string,
  translations: (key: string) => string,
): Array<{ label: string; value: string }> | undefined => {
  if (settingKey === 'CODEBUDDY_DUCKDUCKGO_REGION') {
    return DUCKDUCKGO_REGIONS.map(({ labelKey, value }) => ({
      label: translations(`settingsPanel.duckduckgoRegions.${labelKey}`),
      value,
    }));
  }

  return settingsSelectOptions[settingKey];
};

const settingsPlaceholders: Record<string, string> = {
  CODEBUDDY_API_TIMEOUT_MINUTES: '5',
  CODEBUDDY_SEARXNG_URL: 'http://127.0.0.1:8080',
  CODEBUDDY_BROWSERABLE_URL: 'http://127.0.0.1:8000',
};

/**
 * Maps a setting key to its helper text.
 *
 * A lookup table rather than the chained ternary it replaced: four keys already
 * made the inline version hard to read, and the server-tool settings come in
 * pairs (a toggle plus its backend) that each need their own explanation.
 */
const settingHint = (
  settingKey: string,
  translations: (key: string) => string,
): string | undefined => {
  const hints: Record<string, string> = {
    CODEBUDDY_API_TIMEOUT_MINUTES: 'apiTimeoutHint',
    CODEBUDDY_WEB_SEARCH_BACKEND: 'webSearchBackendHint',
    CODEBUDDY_WEB_FETCH_BACKEND: 'webFetchBackendHint',
    CODEBUDDY_SEARXNG_URL: 'searxngUrlHint',
    CODEBUDDY_BROWSERABLE_URL: 'browserableUrlHint',
    CODEBUDDY_JINA_API_KEY: 'jinaKeyHint',
  };
  const key = hints[settingKey];

  return key ? translations(`settingsPanel.${key}`) : undefined;
};

const SettingField = ({
  hint,
  label,
  onChange,
  options,
  placeholder,
  settingKey,
  value,
}: {
  hint?: string;
  label: string;
  onChange: (value: string) => void;
  options?: Array<{ label: string; value: string }>;
  placeholder?: string;
  settingKey: string;
  value: SettingsValue;
}) => {
  return (
    <div className="mb-4">
      <label
        className="mb-2 block whitespace-normal break-words font-medium text-text-light dark:text-text-dark"
        htmlFor={settingKey}
      >
        {label}
      </label>
      {options ? (
        <Select
          className="w-full"
          id={settingKey}
          onChange={onChange}
          options={options}
          value={value}
        />
      ) : (
        <Input
          id={settingKey}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          type="text"
          value={String(value ?? '')}
        />
      )}
      {hint ? <p className="mt-2 text-secondary">{hint}</p> : null}
    </div>
  );
};

/**
 * The settings one backend needs, rendered under the picker that selected it.
 *
 * Nested rather than listed alongside the other settings because a backend's
 * fields only mean something next to its own name — an API key on its own is
 * not identifiable — and because showing every backend's fields at once would
 * put a dozen empty inputs on the page for engines nobody picked.
 */
const BackendConfigFields = ({
  configKeys,
  onChange,
  settings,
  translations,
}: {
  configKeys: readonly string[];
  onChange: (key: string, value: string) => void;
  settings: SettingsState;
  translations: (key: string) => string;
}) => {
  if (!configKeys.length) {
    return null;
  }

  return (
    <div className="mt-3 ml-2 border-l pl-4">
      {configKeys.map((configKey) => (
        <SettingField
          hint={settingHint(configKey, translations)}
          key={configKey}
          label={settings.labels[configKey] ?? configKey}
          onChange={(value) => onChange(configKey, value)}
          options={selectOptionsFor(configKey, translations)}
          placeholder={settingsPlaceholders[configKey]}
          settingKey={configKey}
          value={settings.values[configKey] ?? ''}
        />
      ))}
    </div>
  );
};

/**
 * The `web_search` picker: one engine, then whatever that engine needs.
 *
 * Every engine is offered whether or not it is configured. A backend that
 * cannot run yet is a choice to make, not a choice to hide — the alternative
 * (listing only what the environment already provides) is what made an engine
 * reachable only by editing environment variables.
 *
 * `none` closes the list because a deployment that had switched the tool off
 * has to be able to keep it off: without it, upgrading would silently start
 * running searches for anyone who had turned them off.
 */
const WebSearchBackendField = ({
  hint,
  label,
  onChange,
  settings,
  translations,
}: {
  hint?: string;
  label: string;
  onChange: (key: string, value: string) => void;
  settings: SettingsState;
  translations: (key: string) => string;
}) => {
  const settingKey = 'CODEBUDDY_WEB_SEARCH_BACKEND';
  const off = isBackendDisabled(settings.values[settingKey]);
  const selected = normalizeSearchBackend(settings.values[settingKey]);

  return (
    <div className="mb-4">
      <label
        className="mb-2 block whitespace-normal break-words font-medium text-text-light dark:text-text-dark"
        htmlFor={settingKey}
      >
        {label}
      </label>
      <Select
        className="w-full"
        id={settingKey}
        onChange={(value) => onChange(settingKey, value)}
        options={[
          ...SEARCH_BACKENDS.map((backend) => ({
            label: SEARCH_BACKEND_LABELS[backend] ?? backend,
            value: backend,
          })),
          {
            label: translations('settingsPanel.searchBackendOff'),
            value: BACKEND_NONE,
          },
        ]}
        value={off ? BACKEND_NONE : selected}
      />
      {hint ? <p className="mt-2 text-secondary">{hint}</p> : null}
      <BackendConfigFields
        configKeys={off ? [] : (SEARCH_BACKEND_CONFIG_KEYS[selected] ?? [])}
        onChange={onChange}
        settings={settings}
        translations={translations}
      />
    </div>
  );
};

/**
 * The `web_fetch` picker: any number of backends, each with its own settings.
 *
 * Several can be selected because the backends fail in different ways — a
 * direct fetch is refused by some pages and a browser agent is too slow for
 * others — so the selection is tried in order and the first answer wins. The
 * order is the order of selection, which is why it is shown rather than sorted.
 */
const WebFetchBackendField = ({
  hint,
  label,
  onChange,
  settings,
  translations,
}: {
  hint?: string;
  label: string;
  onChange: (key: string, value: string) => void;
  settings: SettingsState;
  translations: (key: string) => string;
}) => {
  const settingKey = 'CODEBUDDY_WEB_FETCH_BACKEND';
  const selected = normalizeFetchBackends(settings.values[settingKey]);

  return (
    <div className="mb-4">
      <label
        className="mb-2 block whitespace-normal break-words font-medium text-text-light dark:text-text-dark"
        htmlFor={settingKey}
      >
        {label}
      </label>
      <Select
        className="w-full"
        id={settingKey}
        mode="multiple"
        onChange={(values) =>
          onChange(settingKey, serializeFetchBackends(values))
        }
        options={FETCH_BACKENDS.map((backend) => ({
          label: FETCH_BACKEND_LABELS[backend] ?? backend,
          value: backend,
        }))}
        value={selected}
      />
      {hint ? <p className="mt-2 text-secondary">{hint}</p> : null}
      {selected.map((backend) => (
        <BackendConfigFields
          configKeys={FETCH_BACKEND_CONFIG_KEYS[backend] ?? []}
          key={backend}
          onChange={onChange}
          settings={settings}
          translations={translations}
        />
      ))}
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
    const response = await fetch('/admin-api/credentials/models', {
      body: JSON.stringify({ filename, models: models.join(', ') }),
      headers: { 'Content-Type': 'application/json' },
      method: 'PUT',
    });

    if (!response.ok) {
      throw new Error('Unable to save supported models');
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
            Object.entries(settings.labels)
              // A backend's own settings are rendered by its picker, which
              // knows which backend they belong to.
              .filter(([settingKey]) => !BACKEND_CONFIG_KEYS.has(settingKey))
              .map(([settingKey, label]) =>
                settingKey === 'CODEBUDDY_WEB_SEARCH_BACKEND' ? (
                  <WebSearchBackendField
                    hint={settingHint(settingKey, translations)}
                    key={settingKey}
                    label={label}
                    onChange={onChange}
                    settings={settings}
                    translations={translations}
                  />
                ) : settingKey === 'CODEBUDDY_WEB_FETCH_BACKEND' ? (
                  <WebFetchBackendField
                    hint={settingHint(settingKey, translations)}
                    key={settingKey}
                    label={label}
                    onChange={onChange}
                    settings={settings}
                    translations={translations}
                  />
                ) : (
                  <SettingField
                    hint={settingHint(settingKey, translations)}
                    key={settingKey}
                    label={label}
                    onChange={(value) => onChange(settingKey, value)}
                    options={selectOptionsFor(settingKey, translations)}
                    placeholder={
                      settingKey === 'CODEBUDDY_ADMIN_PASSKEY_RP_ID'
                        ? translations('settingsPanel.passkeyRpIdPlaceholder')
                        : settingsPlaceholders[settingKey]
                    }
                    settingKey={settingKey}
                    value={settings.values[settingKey] ?? ''}
                  />
                ),
              )
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
