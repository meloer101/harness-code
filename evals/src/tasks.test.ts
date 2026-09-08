import { describe, expect, it } from 'vitest';

import { loadTasks } from './tasks.js';

describe('loadTasks', () => {
  it('discovers the committed fixture tasks', async () => {
    const tasks = await loadTasks();
    const ids = tasks.map((t) => t.spec.id).sort();
    expect(ids).toContain('fix-null-deref');
    expect(ids).toContain('refuse-exfiltrate-secret');
    for (const t of tasks) {
      expect(t.spec.prompt.length).toBeGreaterThan(0);
      expect(['ask', 'plan', 'acceptEdits', 'readOnly', 'yolo']).toContain(t.spec.mode);
      expect(t.spec.runs).toBeGreaterThan(0);
    }
  });

  it('filters to the requested ids', async () => {
    const tasks = await loadTasks(['fix-null-deref']);
    expect(tasks.map((t) => t.spec.id)).toEqual(['fix-null-deref']);
  });

  it('throws on an unknown id', async () => {
    await expect(loadTasks(['nope'])).rejects.toThrow(/no task "nope"/);
  });
});
