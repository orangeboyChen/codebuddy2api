'use client';

import { Flexbox, Text } from '@lobehub/ui';

/**
 * A passkey the deployment registered cannot be used from this window, and
 * here is the way out of that.
 *
 * A passkey is bound to the host it was registered for — the deployment's — and
 * this console is served from loopback, so the browser will not offer one here
 * whatever the address in the settings says. The passwords the browser or the
 * system saved for that host are the same story. The deployment's own page, in
 * a real browser, is where both work, so say so and link to it: the desktop
 * shell opens a link that leaves the console in the system browser.
 */
const DeploymentPasskeyHint = ({
  deploymentUrl,
  hint,
  openLabel,
}: {
  deploymentUrl: string;
  hint: string;
  openLabel: string;
}) => {
  const host = (() => {
    try {
      return new URL(deploymentUrl).host;
    } catch {
      return deploymentUrl;
    }
  })();

  return (
    <Flexbox gap={4}>
      <Text fontSize={14} type="secondary">
        {hint.replaceAll('{host}', host)}
      </Text>
      <a className="text-sm underline" href={deploymentUrl} rel="noreferrer">
        {openLabel.replaceAll('{host}', host)}
      </a>
    </Flexbox>
  );
};

export default DeploymentPasskeyHint;
