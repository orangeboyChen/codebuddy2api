import { describe, expect, it } from 'vitest';

import type { ApiTestInitialData, DashboardInitialData } from '@/app/page-data';
import { createApiTestState } from '@/app/api-test/api-test';
import { createDashboardState } from '@/app/dashboard/dashboard';

const createDashboardInitialData = (): DashboardInitialData => {
  return {
    apiEndpoint: 'https://api.example.test/v1',
    tab: 'dashboard',
    totalCredentials: 3,
    validCredentials: 2,
    usage: {
      rangeSummary: { cacheHitTokens: 3, callCount: 2, totalTokens: 9 },
    },
  };
};

const createApiTestInitialData = (): ApiTestInitialData => {
  return {
    credentials: [],
    currentCredential: { status: 'empty' },
    modelSettings: '',
    tab: 'api-test',
  };
};

describe('admin initial state', () => {
  it('hydrates the fixed today usage summary', () => {
    const state = createDashboardState(createDashboardInitialData());

    expect(state.summary).toEqual({
      cacheHitTokens: 3,
      callCount: 2,
      totalTokens: 9,
    });
    expect(state.totalCredentials).toBe(3);
    expect(state.validCredentials).toBe(2);
  });

  it('selects the current valid credential for API testing', () => {
    const initialData = createApiTestInitialData();
    initialData.currentCredential = {
      filename: 'current.json',
      status: 'available',
    };
    initialData.credentials = [
      {
        created_at: null,
        domain: '',
        email: '',
        enterprise_id: null,
        expires_at: null,
        expires_in: null,
        filename: 'fallback.json',
        first_message_role_to_system: false,
        has_refresh_token: false,
        index: 0,
        is_expired: false,
        name: null,
        responses_passthrough: false,
        scope: null,
        session_state: null,
        tenant_id: null,
        time_remaining: null,
        time_remaining_str: '',
        token_type: '',
        user_id: '',
      },
      {
        created_at: null,
        domain: '',
        email: '',
        enterprise_id: null,
        expires_at: null,
        expires_in: null,
        filename: 'current.json',
        first_message_role_to_system: false,
        has_refresh_token: false,
        index: 1,
        is_expired: false,
        name: null,
        responses_passthrough: false,
        scope: null,
        session_state: null,
        tenant_id: null,
        time_remaining: null,
        time_remaining_str: '',
        token_type: '',
        user_id: '',
      },
    ];

    expect(createApiTestState(initialData).credentialFilename).toBe(
      'current.json',
    );
  });
});
