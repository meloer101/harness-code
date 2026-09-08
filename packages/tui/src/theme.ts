/**
 * The TUI's colour system.
 *
 * One accent — Apple system blue, calibrated for a terminal — everything else
 * near-black / near-white, no background (the terminal's own background wins).
 * Accent is reserved for focus, the plan-mode dot, spinners, links and modal
 * borders; headings are bold `text`, never accent. That restraint is the look.
 *
 * Light theme is structurally present but v1 ships dark only; auto-detection
 * and `/theme` persistence land later.
 */

export interface Theme {
  name: 'dark' | 'light';
  text: string;
  dim: string;
  faint: string;
  accent: string;
  success: string;
  warning: string;
  error: string;
  toolBorder: string;
}

export const DARK: Theme = {
  name: 'dark',
  text: '#E6E6E6',
  dim: '#9B9B9B',
  faint: '#5A5A5A',
  accent: '#0A84FF',
  success: '#3FB950',
  warning: '#D29922',
  error: '#F85149',
  toolBorder: '#5A5A5A',
};

export const LIGHT: Theme = {
  name: 'light',
  text: '#1A1A1A',
  dim: '#6B6B6B',
  faint: '#C8C8C8',
  accent: '#0066CC',
  success: '#1A7F37',
  warning: '#9A6700',
  error: '#CF222E',
  toolBorder: '#C8C8C8',
};
