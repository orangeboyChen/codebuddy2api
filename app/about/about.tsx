'use client';

import { Block, Flexbox } from '@lobehub/ui';
import { Info } from 'lucide-react';
import { useTranslations } from 'next-intl';

/**
 * Which builds are involved.
 *
 * `desktopVersion` is the app that opened this console — the desktop build
 * plants it in a cookie, so it survives the redirect a remote console makes to
 * its sign-in page. `serverVersion` is the deployment serving this page, which
 * is a separate build whenever the console is not the app's own gateway, and
 * can then be ahead of or behind the app.
 */
const About = ({
  desktopVersion = '',
  serverVersion = '',
}: {
  desktopVersion?: string;
  serverVersion?: string;
}) => {
  const translations = useTranslations('Admin.aboutPanel');
  const desktop = desktopVersion.trim();
  const server = serverVersion.trim();

  const version = (value: string): string =>
    value ? `v${value}` : translations('unknown');

  return (
    <Block
      className="min-w-0 max-w-full"
      direction="vertical"
      gap={16}
      padding={24}
      variant="outlined"
    >
      <Flexbox align="center" gap={8} horizontal>
        <Info size={18} strokeWidth={2} />
        <h3 className="section-title">{translations('title')}</h3>
      </Flexbox>
      {desktop ? (
        <Flexbox align="center" gap={12} horizontal justify="space-between">
          <span className="whitespace-normal break-words font-medium text-text-light dark:text-text-dark">
            {translations('desktopVersion')}
          </span>
          <span className="text-secondary">{version(desktop)}</span>
        </Flexbox>
      ) : null}
      {server ? (
        <Flexbox align="center" gap={12} horizontal justify="space-between">
          <span className="whitespace-normal break-words font-medium text-text-light dark:text-text-dark">
            {translations('serverVersion')}
          </span>
          <span className="text-secondary">{version(server)}</span>
        </Flexbox>
      ) : null}
      <p className="mt-2 text-secondary">
        {server ? translations('serverHint') : translations('localHint')}
      </p>
    </Block>
  );
};

export default About;
