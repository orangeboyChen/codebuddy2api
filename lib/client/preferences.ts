import type { LocalePreference } from '@/lib/i18n/routing';
import type { ResolvedThemeMode, ThemeMode } from '@/lib/theme';

export const saveLocalePreference = async (
  localePreference: LocalePreference,
): Promise<void> => {
  const response = await fetch('/admin-api/preferences', {
    body: JSON.stringify({ localePreference }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });

  if (!response.ok) {
    throw new Error('Failed to save locale preference');
  }
};

export const saveThemePreference = async (
  theme: ThemeMode,
  resolvedTheme: ResolvedThemeMode,
): Promise<void> => {
  const response = await fetch('/admin-api/preferences', {
    body: JSON.stringify({ resolvedTheme, theme }),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });

  if (!response.ok) {
    throw new Error('Failed to save theme preference');
  }
};
