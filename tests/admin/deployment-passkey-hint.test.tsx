// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';

import DeploymentPasskeyHint from '@/app/deployment-passkey-hint';

describe('DeploymentPasskeyHint', () => {
  it('names the deployment, and links to its own page', () => {
    render(
      <DeploymentPasskeyHint
        deploymentUrl="https://codebuddy.example.com/console"
        hint="Passkeys belong to {host}."
        openLabel="Open {host} in a browser"
      />,
    );

    expect(
      screen.getByText('Passkeys belong to codebuddy.example.com.'),
    ).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: 'Open codebuddy.example.com in a browser' })
        .getAttribute('href'),
    ).toBe('https://codebuddy.example.com/console');
  });

  it('says the address it was given when that is not one', () => {
    render(
      <DeploymentPasskeyHint
        deploymentUrl="not an address"
        hint="Passkeys belong to {host}."
        openLabel="Open {host}"
      />,
    );

    expect(screen.getByText('Passkeys belong to not an address.')).toBeTruthy();
  });
});
