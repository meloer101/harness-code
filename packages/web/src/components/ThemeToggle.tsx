import { Monitor, Moon, Sun } from 'lucide-react';

import { nextTheme, setTheme, useTheme } from '@/lib/theme';
import type { Theme } from '@/lib/theme';

const ICONS: Record<Theme, typeof Sun> = {
  system: Monitor,
  light: Sun,
  dark: Moon,
};

const LABELS: Record<Theme, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};

/** Cycles system → light → dark. One button, three states, no menu. */
export function ThemeToggle() {
  const theme = useTheme();
  const Icon = ICONS[theme];
  return (
    <button
      type="button"
      onClick={() => setTheme(nextTheme(theme))}
      className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      title={`Theme: ${LABELS[theme]} — click to switch`}
      aria-label={`Theme: ${LABELS[theme]}. Activate to switch.`}
    >
      <Icon className="size-3.5" />
      {LABELS[theme]}
    </button>
  );
}
