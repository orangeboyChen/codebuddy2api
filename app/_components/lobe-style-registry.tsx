'use client';

import { extractStaticStyle } from 'antd-style';
import { useServerInsertedHTML } from 'next/navigation';
import { useRef, type ReactNode } from 'react';

interface LobeStyleRegistryProps {
  children: ReactNode;
}

const LobeStyleRegistry = ({ children }: LobeStyleRegistryProps) => {
  const emitted = useRef(false);

  useServerInsertedHTML(() => {
    if (emitted.current) {
      return null;
    }

    emitted.current = true;

    return extractStaticStyle(undefined, { includeAntd: false }).map(
      (style) => style.style,
    );
  });

  return children;
};

export default LobeStyleRegistry;
