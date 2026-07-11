import type { AbstractIntlMessages } from 'next-intl';

import enUS from '@/messages/en-US.json';
import jaJP from '@/messages/ja-JP.json';
import zhCN from '@/messages/zh-CN.json';

import type { AppLocale } from '@/lib/i18n/routing';

const messages = {
  'en-US': enUS,
  'ja-JP': jaJP,
  'zh-CN': zhCN,
} satisfies Record<AppLocale, AbstractIntlMessages>;

export type AppMessages = typeof zhCN;
export type AdminMessages = AppMessages['Admin'];
export type AdminTranslations = AdminMessages;
export type AdminLoginMessages = AdminMessages['loginPage'];

export const getMessages = (locale: AppLocale) => {
  return messages[locale];
};

export const createAdminTranslations = (messages: AdminMessages) => {
  return messages;
};
