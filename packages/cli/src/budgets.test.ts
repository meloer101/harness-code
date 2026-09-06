import { describe, expect, it } from 'vitest';

import { resolveBudgets } from './budgets.js';

describe('resolveBudgets', () => {
  it('uses settings.json when no flag is given — the regression this guards against', () => {
    // Before resolveBudgets, `hc agent` forwarded only flags: this used to
    // silently fall through to the loop default of 50.
    const b = resolveBudgets({}, { maxTurns: 2 });
    expect(b.maxTurns).toBe(2);
  });

  it('lets a flag win over settings', () => {
    const b = resolveBudgets({ maxTurns: 5 }, { maxTurns: 2 });
    expect(b.maxTurns).toBe(5);
  });

  it('leaves a field undefined when neither flag nor settings set it', () => {
    const b = resolveBudgets({}, {});
    expect(b.maxTurns).toBeUndefined();
    expect(b.maxCostUSD).toBeUndefined();
    expect(b.maxTokens).toBeUndefined();
    expect(b.maxOutputTokens).toBeUndefined();
  });

  it('carries maxTokens / maxOutputTokens / temperature through from settings', () => {
    const b = resolveBudgets(
      { maxTokens: 500 },
      { maxTokens: 999, maxOutputTokens: 4096, temperature: 0.3 },
    );
    expect(b.maxTokens).toBe(500);
    expect(b.maxOutputTokens).toBe(4096);
    expect(b.temperature).toBe(0.3);
  });
});
