/**
 * The `list_skills` tool — the escape hatch for the manifest token cap.
 *
 * The `<available_skills>` system segment is capped at `MAX_MANIFEST_TOKENS`;
 * when more skills are discovered than fit, the overflow is dropped from the
 * manifest and would otherwise be loadable only by an exact name the model never
 * sees. This tool returns the full catalog on demand — every skill's name and
 * description — so the model can find and then `skill`-load one that wasn't
 * advertised. It is only registered when the catalog actually dropped skills.
 *
 * Read-only: it reads the in-memory catalog and touches nothing in the
 * workspace, so it is allowed in every permission mode.
 */

import { z } from 'zod';

import type { ToolSpec } from '../tools/types.js';
import type { SkillCatalog } from './catalog.js';

const schema = z.object({});

export function createListSkillsTool(catalog: SkillCatalog): ToolSpec<z.infer<typeof schema>> {
  return {
    name: 'list_skills',
    description:
      'List every available skill (name and description), including any not shown in ' +
      '<available_skills> because of the manifest size limit. Use this to discover a skill ' +
      'to load with the `skill` tool.',
    schema,
    readOnly: true,
    concurrencySafe: true,
    async execute() {
      const skills = catalog.list().sort((a, b) => a.name.localeCompare(b.name));
      if (skills.length === 0) {
        return { content: 'No skills are available.' };
      }
      const advertised = new Set(catalog.advertised);
      const lines = skills.map((s) => {
        const mark = advertised.has(s.name) ? '' : ' (not in <available_skills>)';
        return `- ${s.name}: ${s.description}${mark}`;
      });
      return {
        content:
          `${skills.length} skill${skills.length === 1 ? '' : 's'} available. ` +
          `Load one with the \`skill\` tool by its exact name:\n\n${lines.join('\n')}`,
      };
    },
  };
}
