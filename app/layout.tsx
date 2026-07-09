import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import '@fortawesome/fontawesome-free/css/all.min.css';
import './globals.scss';

export const metadata: Metadata = {
  title: 'CodeBuddy2API Console',
  description: 'Next.js admin shell for the CodeBuddy2API migration.',
};

const RootLayout = ({
  children,
}: Readonly<{
  children: ReactNode;
}>) => {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
};

export default RootLayout;
