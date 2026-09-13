/**
 * The set of skills available this session, and the `<available_skills>` system
 * segment they collapse into.
 *
 * Progressive disclosure tier 1: only `name: description` reaches the system
 * prompt at startup. `MAX_MANIFEST_TOKENS` caps that segment — if the discovered
 * skills would overflow it, the lowest-priority ones are left out of the
 * manifest (still loadable by exact name via the `skill` tool, just not
 * advertised). This is the whole of Phase 6's context degradation: the manifest
 * is the only new bucket that is both variable and sheddable, and it is small.
 */

import { heuristicTokenCount, type TokenCounter } from '../context/tokenizer.js';
import type { Skill } from './types.js';

/** Ceiling for the `<available_skills>` segment. ~30 skills at a one-line description each. */
export const MAX_MANIFEST_TOKENS = 1500;

const MANIFEST_PREAMBLE =
  'Specialized instruction sets you can load on demand. When a task matches one, ' +
  'call the `skill` tool with its name to load its full instructions before proceeding. ' +
  'Do not guess at what a skill contains — load it.';

export class SkillCatalog {
  private readonly byName = new Map<string, Skill>();
  /** Names included in the manifest (a prefix of the discovery order after the token cap). */
  readonly advertised: string[];
  readonly dropped: string[];

  constructor(skills: readonly Skill[], count: TokenCounter = heuristicTokenCount) {
    for (const s of skills) this.byName.set(s.name, s);

    const advertised: string[] = [];
    const dropped: string[] = [];
    let running = count(`<available_skills>\n${MANIFEST_PREAMBLE}\n\n</available_skills>`);
    for (const s of skills) {
      const line = `- ${s.name}: ${s.description}\n`;
      const cost = count(line);
      if (advertised.length > 0 && running + cost > MAX_MANIFEST_TOKENS) {
        dropped.push(s.name);
      } else {
        advertised.push(s.name);
        running += cost;
      }
    }
    this.advertised = advertised;
    this.dropped = dropped;
  }

  get size(): number {
    return this.byName.size;
  }

  list(): Skill[] {
    return [...this.byName.values()];
  }

  get(name: string): Skill | undefined {
    return this.byName.get(name);
  }

  /** The `<available_skills>` segment text, or `undefined` when nothing is advertised. */
  manifest(): string | undefined {
    if (this.advertised.length === 0) return undefined;
    const lines = this.advertised.map((n) => {
      const s = this.byName.get(n)!;
      return `- ${s.name}: ${s.description}`;
    });
    // When the token cap left skills out, say so and point at the escape hatch —
    // otherwise those skills are loadable only by a name the model never sees.
    const overflow =
      this.dropped.length > 0
        ? `\n\n${this.dropped.length} more skill${this.dropped.length === 1 ? '' : 's'} ` +
          `${this.dropped.length === 1 ? 'is' : 'are'} available but not listed here; ` +
          'call the `list_skills` tool to see the full catalog.'
        : '';
    return `<available_skills>\n${MANIFEST_PREAMBLE}\n\n${lines.join('\n')}${overflow}\n</available_skills>`;
  }

  manifestTokens(count: TokenCounter = heuristicTokenCount): number {
    const m = this.manifest();
    return m ? count(m) : 0;
  }
}
