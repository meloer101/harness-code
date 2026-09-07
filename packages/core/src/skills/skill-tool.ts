/**
 * The `skill` tool — progressive disclosure tier 2.
 *
 * The model calls this with a skill name; it returns that skill's SKILL.md body
 * as the tool result, so the full instructions enter context only now, on
 * demand. Reference files under the skill directory stay on disk until the model
 * reads them (tier 3).
 *
 * Read-only: it copies bundled instructions into context and touches nothing in
 * the workspace, so it is allowed in every permission mode (a `Deny(Skill)` rule
 * still blocks it). Activation is reported through `ctx.control` so the harness
 * can narrow the tool set to the skill's `allowed-tools`, if it declared any.
 */

import { z } from 'zod';

import type { ToolSpec } from '../tools/types.js';
import type { SkillCatalog } from './catalog.js';

const schema = z.object({
  name: z.string().describe('The exact name of the skill to load, as listed in <available_skills>.'),
});

export function createSkillTool(catalog: SkillCatalog): ToolSpec<z.infer<typeof schema>> {
  return {
    name: 'skill',
    description:
      'Load a specialized instruction set by name (see <available_skills>). ' +
      'Returns the skill\'s full instructions — follow them for the rest of the task.',
    schema,
    readOnly: true,
    concurrencySafe: true,
    async execute(input, ctx) {
      const skill = catalog.get(input.name);
      if (!skill) {
        const known = catalog.list().map((s) => s.name).sort().join(', ') || '(none)';
        return {
          content: `No skill named "${input.name}". Available skills: ${known}.`,
          isError: true,
        };
      }

      ctx.control?.activateSkill?.({
        name: skill.name,
        ...(skill.allowedTools ? { allowedTools: skill.allowedTools } : {}),
      });

      const note = skill.allowedTools
        ? `\n\n(While this skill is active the tool set is limited to: ${skill.allowedTools.join(' ')}.)`
        : '';
      return {
        content:
          `Loaded skill "${skill.name}". Follow these instructions:\n\n` +
          `${skill.body}\n\n` +
          `Reference files, if any, are under ${skill.dir} — read them as the instructions direct.${note}`,
      };
    },
  };
}
