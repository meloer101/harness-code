import { describe, expect, it } from 'vitest';

import { SkillCatalog } from './catalog.js';
import { createListSkillsTool } from './list-tool.js';
import type { Skill } from './types.js';

const skill = (name: string, description = 'a fairly wordy description '.repeat(6)): Skill => ({
  name,
  description,
  body: `# ${name}`,
  dir: `/skills/${name}`,
  source: 'builtin',
});

const ctx = {} as never;

describe('list_skills tool', () => {
  it('lists every skill, flagging the ones dropped from the manifest', async () => {
    // Enough skills that the token cap drops some.
    const many = Array.from({ length: 200 }, (_, i) => skill(`skill-${String(i).padStart(3, '0')}`));
    const cat = new SkillCatalog(many);
    expect(cat.dropped.length).toBeGreaterThan(0);

    const res = await createListSkillsTool(cat).execute({}, ctx);
    expect(res.isError).toBeFalsy();
    // every skill is present
    for (const s of many) expect(res.content).toContain(s.name);
    // a dropped skill is flagged; an advertised one is not
    const dropped = cat.dropped[0]!;
    const advertised = cat.advertised[0]!;
    expect(res.content).toMatch(new RegExp(`${dropped}:.*not in <available_skills>`));
    expect(res.content).not.toMatch(new RegExp(`${advertised}:.*not in <available_skills>`));
  });

  it('is read-only and concurrency-safe', () => {
    const tool = createListSkillsTool(new SkillCatalog([]));
    expect(tool.readOnly).toBe(true);
    expect(tool.concurrencySafe).toBe(true);
  });
});
