export const themeCookieName = 'codebuddy2api-theme';
export const resolvedThemeCookieName = 'codebuddy2api-theme-resolved';
export const themeChangeEventName = 'codebuddy2api-theme-change';

export type ThemeMode = 'dark' | 'light' | 'system';
export type ResolvedThemeMode = Exclude<ThemeMode, 'system'>;

export const resolveThemeMode = (
  value: string | undefined,
): ResolvedThemeMode => {
  return value === 'dark' ? 'dark' : 'light';
};

export const parseThemeMode = (value: string | undefined): ThemeMode => {
  if (value === 'dark' || value === 'light' || value === 'system') {
    return value;
  }

  return 'system';
};
