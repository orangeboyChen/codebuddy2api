'use client';

import type { ReactNode } from 'react';

import type { TabKey, ThemeMode } from '@/features/admin/admin-store';
import { TAB_ITEMS } from '@/features/admin/admin-store';
import type { AdminMessages } from '@/lib/i18n/messages';
import type { AppLocale } from '@/lib/i18n/routing';

interface AdminHeaderProps {
  activeCredentials: number;
  currentLocale: AppLocale;
  onLocaleChange: (locale: AppLocale) => void;
  onLogout: () => void;
  onThemeChange: (theme: ThemeMode) => void;
  theme: ThemeMode;
  translations: AdminMessages;
}

interface AdminTabBarProps {
  activeTab: TabKey;
  onChange: (tab: TabKey) => void;
  translations: AdminMessages;
}

interface AdminSectionFrameProps {
  activeTab: TabKey;
  children: ReactNode;
  translations: AdminMessages;
}

const tabTranslationKeys = {
  'api-test': 'apiTest',
  credentials: 'credentials',
  dashboard: 'dashboard',
  debug: 'debug',
  settings: 'settings',
  usage: 'usage',
} as const;

const sectionTranslationKeys = {
  'api-test': 'apiTest',
  credentials: 'credentials',
  dashboard: 'dashboard',
  debug: 'debug',
  settings: 'settings',
  usage: 'usage',
} as const;

export const AdminHeader = ({
  activeCredentials,
  currentLocale,
  onLocaleChange,
  onLogout,
  onThemeChange,
  theme,
  translations,
}: AdminHeaderProps) => {
  return (
    <header className="sticky top-0 z-40 border-b border-border-light/80 bg-bg-light/95 backdrop-blur dark:border-border-dark/80 dark:bg-bg-dark/95">
      <div className="mx-auto flex max-w-[1400px] flex-col gap-4 px-4 py-4 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-primary">
              CodeBuddy2API
            </div>
            <h1 className="mt-2 text-2xl font-semibold font-serif text-text-light dark:text-text-dark">
              {translations.brand}
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-secondary">
              {translations.description}
            </p>
          </div>
          <div className="flex flex-col items-stretch gap-3 lg:min-w-[360px] lg:items-end">
            <div className="flex flex-wrap items-center justify-end gap-3">
              <div className="rounded-full border border-border-light bg-card-light px-3 py-2 text-xs text-text-light dark:border-border-dark dark:bg-card-dark dark:text-text-dark">
                <span className="font-medium">{translations.statusLabel}:</span>{' '}
                {translations.statusValue.replace(
                  '{count}',
                  String(activeCredentials),
                )}
              </div>
              <button
                className="inline-flex items-center gap-2 rounded-full border border-border-light bg-card-light px-4 py-2 text-sm font-medium text-text-light transition hover:border-primary hover:text-primary dark:border-border-dark dark:bg-card-dark dark:text-text-dark"
                onClick={onLogout}
                type="button"
              >
                <i className="fas fa-arrow-right-from-bracket"></i>
                {translations.logoutLabel}
              </button>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="flex items-center gap-2 text-sm text-secondary">
                <span className="shrink-0">{translations.localeLabel}</span>
                <select
                  aria-label={translations.localeLabel}
                  className="min-w-0 rounded-full border border-border-light bg-card-light px-3 py-2 text-sm text-text-light transition hover:border-primary focus:border-primary focus:outline-none focus:ring-3 focus:ring-primary/10 dark:border-border-dark dark:bg-card-dark dark:text-text-dark"
                  value={currentLocale}
                  onChange={(event) => {
                    onLocaleChange(event.target.value as AppLocale);
                  }}
                >
                  <option value="zh-CN">简体中文</option>
                  <option value="en-US">English</option>
                  <option value="ja-JP">日本語</option>
                </select>
              </label>
              <label className="flex items-center gap-2 text-sm text-secondary">
                <span className="shrink-0">{translations.themeLabel}</span>
                <select
                  aria-label={translations.themeLabel}
                  className="min-w-0 rounded-full border border-border-light bg-card-light px-3 py-2 text-sm text-text-light transition hover:border-primary focus:border-primary focus:outline-none focus:ring-3 focus:ring-primary/10 dark:border-border-dark dark:bg-card-dark dark:text-text-dark"
                  value={theme}
                  onChange={(event) => {
                    onThemeChange(event.target.value as ThemeMode);
                  }}
                >
                  <option value="system">{translations.themeSystem}</option>
                  <option value="light">{translations.themeLight}</option>
                  <option value="dark">{translations.themeDark}</option>
                </select>
              </label>
            </div>
            <p className="max-w-md text-right text-xs leading-5 text-secondary">
              {translations.topbarHint}
            </p>
          </div>
        </div>
      </div>
    </header>
  );
};

export const AdminTabBar = ({
  activeTab,
  onChange,
  translations,
}: AdminTabBarProps) => {
  return (
    <nav
      aria-label={translations.tabsLabel}
      className="mb-8 -mx-4 overflow-x-auto px-4 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8"
    >
      <div className="inline-flex min-w-full gap-2 rounded-[28px] border border-border-light/80 bg-card-light/80 p-2 shadow-sm dark:border-border-dark/80 dark:bg-card-dark/80 sm:min-w-0">
        {TAB_ITEMS.map((tab) => (
          <button
            key={tab.key}
            className={
              tab.key === activeTab
                ? 'inline-flex min-w-max items-center gap-2 rounded-full bg-primary px-4 py-3 text-sm font-medium text-white transition'
                : 'inline-flex min-w-max items-center gap-2 rounded-full px-4 py-3 text-sm font-medium text-secondary transition hover:bg-bg-light hover:text-primary dark:hover:bg-bg-dark'
            }
            onClick={() => {
              onChange(tab.key);
            }}
            type="button"
          >
            <i className={tab.icon}></i>
            {translations.tabs[tabTranslationKeys[tab.key]]}
          </button>
        ))}
      </div>
    </nav>
  );
};

export const AdminSectionFrame = ({
  activeTab,
  children,
  translations,
}: AdminSectionFrameProps) => {
  const section = translations.sections[sectionTranslationKeys[activeTab]];

  return (
    <section>
      <div className="mb-6 rounded-[32px] border border-border-light bg-card-light/90 px-5 py-6 shadow-sm dark:border-border-dark dark:bg-card-dark/90 sm:px-6">
        <div className="text-[11px] font-semibold uppercase tracking-[0.24em] text-primary">
          {section.eyebrow}
        </div>
        <div className="mt-3 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <h2 className="max-w-3xl text-2xl font-semibold font-serif text-text-light dark:text-text-dark">
            {section.title}
          </h2>
          {activeTab === 'credentials' ? (
            <div className="rounded-3xl border border-primary/20 bg-primary/8 px-4 py-3 text-sm text-secondary">
              <div className="font-medium text-text-light dark:text-text-dark">
                {translations.authHooks.loginTitle}
              </div>
              <div className="mt-1 max-w-xl leading-6">
                {translations.authHooks.loginDescription}
              </div>
            </div>
          ) : null}
        </div>
      </div>
      {children}
    </section>
  );
};
