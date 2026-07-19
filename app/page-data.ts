'use client';

import type {
  AccessKeySummary,
  CredentialSummary,
  CurrentCredentialInfo,
} from '@/app/credentials/credentials';
import type { AdminDebugSnapshot } from '@/app/debug/debug';

export type TabKey =
  'dashboard' | 'usage' | 'credentials' | 'api-test' | 'debug' | 'settings';

export interface AdminSettingsSnapshot {
  labels: Record<string, string>;
  values: Record<string, string | number | null>;
}

export interface DashboardInitialData {
  apiEndpoint: string;
  tab: 'dashboard';
  totalCredentials: number;
  validCredentials: number;
  usage: Pick<import('@/app/usage/usage').AdminUsageSnapshot, 'rangeSummary'>;
}

export interface UsageTabInitialData {
  tab: 'usage';
  usage: import('@/app/usage/usage').AdminUsageSnapshot;
}

export interface CredentialsTabInitialData {
  accessKeys: AccessKeySummary[];
  credentials: CredentialSummary[];
  currentCredential: CurrentCredentialInfo;
  tab: 'credentials';
}

export interface ApiTestInitialData {
  credentials: CredentialSummary[];
  currentCredential: CurrentCredentialInfo;
  modelSettings: string;
  tab: 'api-test';
}

export interface DebugTabInitialData {
  debug: AdminDebugSnapshot;
  tab: 'debug';
}

export interface SettingsTabInitialData {
  settings: AdminSettingsSnapshot;
  tab: 'settings';
}

export type AdminConsoleInitialData =
  | ApiTestInitialData
  | CredentialsTabInitialData
  | DashboardInitialData
  | DebugTabInitialData
  | SettingsTabInitialData
  | UsageTabInitialData;
