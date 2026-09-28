// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import { defaultCredentialsState } from '@/app/credentials/credentials';

describe('credential form defaults', () => {
  // Both conversions start on. Upstreams that reject a developer or system
  // prompt are common enough that leaving them off meant a first request that
  // failed for a reason the console never showed.
  it('sends the first system prompt and developer messages as user', () => {
    expect(defaultCredentialsState.form.firstMessageRoleToSystem).toBe(true);
    expect(defaultCredentialsState.form.firstSystemMessageRoleToUser).toBe(
      true,
    );
  });
});
