import { describe, expect, it } from 'vitest';

import { renderBanner } from './banner.js';
import { DARK } from './theme.js';

describe('renderBanner', () => {
  it('renders the MARVIS wordmark in the accent colour with a tagline', () => {
    const out = renderBanner(DARK);
    // All six rows of the ANSI-Shadow wordmark are present.
    expect(out).toContain('███╗   ███╗');
    expect(out).toContain('╚═╝     ╚═╝');
    expect(out.split('\n').filter((l) => /[█╝]/.test(l)).length).toBe(6);
    // Accent as a truecolor SGR (DARK.accent #0A84FF → 10;132;255) and a reset.
    expect(out).toContain('\x1b[38;2;10;132;255m');
    expect(out).toContain('\x1b[0m');
    expect(out).toContain('type /help for commands');
  });
});
