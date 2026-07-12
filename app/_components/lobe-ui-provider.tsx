'use client';

import { ConfigProvider, ThemeProvider } from '@lobehub/ui';
import { motion } from 'motion/react';
import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import { themeChangeEventName, type ThemeMode } from '@/lib/theme';

interface LobeUiProviderProps {
  children: ReactNode;
  initialTheme: ThemeMode;
}

const resolveThemeMode = (theme: ThemeMode) => {
  return theme === 'system' ? 'auto' : theme;
};

const subscribeToMount = () => {
  return () => {};
};

const LobeUiProvider = ({ children, initialTheme }: LobeUiProviderProps) => {
  const hasMounted = useSyncExternalStore(
    subscribeToMount,
    () => true,
    () => false,
  );
  const [appearance, setAppearance] = useState<'dark' | 'light'>(
    initialTheme === 'dark' ? 'dark' : 'light',
  );

  useEffect(() => {
    const syncAppearance = (event: Event) => {
      const nextAppearance = (event as CustomEvent<'dark' | 'light'>).detail;

      if (nextAppearance === 'dark' || nextAppearance === 'light') {
        setAppearance(nextAppearance);
      }
    };

    window.addEventListener(themeChangeEventName, syncAppearance);

    return () => {
      window.removeEventListener(themeChangeEventName, syncAppearance);
    };
  }, []);

  if (!hasMounted) {
    return children;
  }

  return (
    <ConfigProvider motion={motion}>
      <ThemeProvider
        appearance={appearance}
        themeMode={resolveThemeMode(appearance)}
      >
        {children}
      </ThemeProvider>
    </ConfigProvider>
  );
};

export default LobeUiProvider;
