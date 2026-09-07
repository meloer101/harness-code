export const READ_ONLY_TOOLS = new Set(['read', 'glob', 'grep', 'skill']);
export const KNOWN_TOOLS = new Set([
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'bash',
  'todo',
  'skill',
  'task',
  'exit_plan_mode',
]);

/** Relative-path prefix (posix, workspace-rooted) that plan mode lets write/edit through. */
export const PLANS_DIR_PREFIX = '.agent/plans/';

/** Built-in default allow list used by settings — not applied inside the engine itself. */
export const DEFAULT_ALLOW_RULES = ['Read', 'Glob', 'Grep', 'Todo', 'Skill'];
