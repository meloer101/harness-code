import { describe, expect, it } from 'vitest';

import { heuristicTokenCount } from '../context/tokenizer.js';
import { MAX_MANIFEST_TOKENS, SkillCatalog } from './catalog.js';
import type { Skill } from './types.js';

const skill = (name: string, description = 'does a thing, use when doing things'): Skill => ({
  name,
  description,
  body: `# ${name}\n\ninstructions`,
  dir: `/skills/${name}`,
  source: 'builtin',
});

describe('SkillCatalog', () => {
  it('builds a manifest listing every skill name and description', () => {
    const cat = new SkillCatalog([skill('code-review'), skill('writing-tests')]);
    const m = cat.manifest()!;
    expect(m).toContain('<available_skills>');
    expect(m).toContain('- code-review: does a thing');
    expect(m).toContain('- writing-tests: does a thing');
    expect(cat.get('code-review')?.name).toBe('code-review');
  });

  it('returns no manifest when empty', () => {
    expect(new SkillCatalog([]).manifest()).toBeUndefined();
    expect(new SkillCatalog([]).manifestTokens()).toBe(0);
  });

  it('keeps the manifest under the token ceiling, dropping the overflow', () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      skill(`skill-${i}`, 'a fairly wordy description '.repeat(6)),
    );
    const cat = new SkillCatalog(many);
    expect(cat.manifestTokens(heuristicTokenCount)).toBeLessThanOrEqual(MAX_MANIFEST_TOKENS);
    expect(cat.advertised.length).toBeGreaterThan(0);
    expect(cat.dropped.length).toBeGreaterThan(0);
    expect(cat.advertised.length + cat.dropped.length).toBe(200);
    // a dropped skill is still loadable by exact name
    expect(cat.get(cat.dropped[0]!)).toBeDefined();
  });
});
