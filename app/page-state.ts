'use client';

import { atom } from 'jotai';

export type ThemeMode = 'light' | 'dark' | 'system';

export interface AdminSessionState {
  authenticated: boolean;
}

export const themeAtom = atom<ThemeMode>('system');

export const adminSessionAtom = atom<AdminSessionState | null>(null);
