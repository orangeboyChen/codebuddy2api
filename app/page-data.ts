'use client';

import type {
  AccessKeySummary,
  CredentialSummary,
  CurrentCredentialInfo,
} from '@/app/credentials/credentials';
import type { AdminDebugSnapshot } from '@/app/debug/debug';

export type TabKey =
  'dashboard' | 'usage' | 'credentials' | 'api-test' | 'debug' | 'settings';

export interface AdminHealthState {
  checkedAtLabel: string;
  status: string;
  timestamp: string;
  uptimeText: string;
}

export interface AdminStatsState {
  credential_usage: Record<string, number>;
  model_usage: Record<string, number>;
}

export interface AdminSettingsSnapshot {
  labels: Record<string, string>;
  values: Record<string, string | number | null>;
}

export interface AdminConsoleInitialData {
  accessKeys: AccessKeySummary[];
  apiEndpoint: string;
  credentials: CredentialSummary[];
  currentCredential: CurrentCredentialInfo;
  debug: AdminDebugSnapshot;
  health: AdminHealthState;
  settings: AdminSettingsSnapshot;
  stats: AdminStatsState;
  usage?: import('@/app/usage/usage').AdminUsageSnapshot;
}
