import { useSyncExternalStore } from 'react';

import { platform } from '@/platform';

/**
 * light / dark / system, persisted via platform storage. The initial class is
 * set by public/theme.js before first paint; this module keeps `<html>` in
 * sync afterwards and reacts to OS changes while in `system`.
 */
export type Theme = 'light' | 'dark' | 'system';

const KEY = 'hc.theme';
// jsdom (component tests) has no matchMedia — degrade to "light, never changes".
const media: Pick<MediaQueryList, 'matches' | 'addEventListener'> =
  typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : { matches: false, addEventListener: () => {} };

function read(): Theme {
  const v = platform.storage.get(KEY);
  return v === 'light' || v === 'dark' ? v : 'system';
}

let current: Theme = read();
const listeners = new Set<() => void>();

function apply(theme: Theme): void {
  const dark = theme === 'dark' || (theme === 'system' && media.matches);
  document.documentElement.classList.toggle('dark', dark);
}

function emit(): void {
  listeners.forEach((l) => l());
}

export function setTheme(theme: Theme): void {
  current = theme;
  platform.storage.set(KEY, theme);
  apply(theme);
  emit();
}

/** Cycles system → light → dark — the toggle button's single action. */
export function nextTheme(theme: Theme): Theme {
  return theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';
}

media.addEventListener('change', () => {
  if (current === 'system') {
    apply(current);
    emit();
  }
});

// Re-assert on load in case storage disagrees with the bootstrap script.
apply(current);

export function useTheme(): Theme {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}
