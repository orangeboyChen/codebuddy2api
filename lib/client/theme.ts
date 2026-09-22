import { useEffect } from 'react';

import { saveThemePreference } from '@/lib/client/preferences';
import {
  themeChangeEventName,
  type ResolvedThemeMode,
  type ThemeMode,
} from '@/lib/theme';

const darkMediaQuery = '(prefers-color-scheme: dark)';

export const prefersDarkColorScheme = (): boolean => {
  if (
    typeof window === 'undefined' ||
    typeof window.matchMedia !== 'function'
  ) {
    return false;
  }

  return window.matchMedia(darkMediaQuery).matches;
};

/**
 * `system` can only be resolved in the browser, so a server-rendered page
 * always starts from the last resolved cookie and can disagree with the OS.
 */
export const resolveThemeAppearance = (theme: ThemeMode): ResolvedThemeMode => {
  if (theme === 'dark' || (theme === 'system' && prefersDarkColorScheme())) {
    return 'dark';
  }

  return 'light';
};

export const applyThemeAppearance = (theme: ThemeMode): ResolvedThemeMode => {
  const appearance = resolveThemeAppearance(theme);
  const isDark = appearance === 'dark';

  document.documentElement.classList.toggle('dark', isDark);
  document.body.classList.toggle('dark', isDark);
  document.documentElement.style.colorScheme = appearance;
  window.dispatchEvent(
    new CustomEvent(themeChangeEventName, { detail: appearance }),
  );
  void saveThemePreference(theme, appearance);

  return appearance;
};

/**
 * Owns every DOM side effect of the theme so the login screen and the console
 * cannot drift apart: both resolve `system` against the OS on mount, follow
 * later OS changes, and persist the resolved value for the next server render.
 */
export const useThemeAppearance = (theme: ThemeMode): void => {
  useEffect(() => {
    applyThemeAppearance(theme);

    if (theme !== 'system' || typeof window.matchMedia !== 'function') {
      return;
    }

    const mediaQuery = window.matchMedia(darkMediaQuery);
    const syncWithSystem = () => {
      applyThemeAppearance('system');
    };

    mediaQuery.addEventListener('change', syncWithSystem);

    return () => {
      mediaQuery.removeEventListener('change', syncWithSystem);
    };
  }, [theme]);
};
