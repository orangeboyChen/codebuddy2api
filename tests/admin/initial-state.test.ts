import { describe, expect, it } from 'vitest';

import {
  createApiTestState,
  createDashboardState,
  type AdminConsoleInitialData,
} from '@/app/admin/_components/admin-initial-state';

const createInitialData = (): AdminConsoleInitialData => {
  return {
    accessKeys: [],
    apiEndpoint: 'http://localhost:8001/v1',
    credentials: [],
    currentCredential: { status: 'empty' },
    debug: {
      autoRefreshSeconds: 15,
      enabled: false,
      items: [],
      maxEntries: 100,
    },
    health: {
      checkedAtLabel: '',
      status: 'healthy',
      timestamp: '2026-07-12T09:00:00.000Z',
      uptimeText: '',
    },
    settings: { labels: {}, values: {} },
    stats: { credential_usage: {}, model_usage: {} },
  };
};

describe('admin initial state', () => {
  it('keeps the service status time visible on the first render', () => {
    expect(createDashboardState(createInitialData()).uptimeText).toBe(
      '2026-07-12T09:00:00.000Z',
    );
  });

  it('selects the current valid credential for API testing', () => {
    const initialData = createInitialData();
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
