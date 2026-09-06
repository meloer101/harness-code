export const READ_ONLY_TOOLS = new Set(['read', 'glob', 'grep']);
export const KNOWN_TOOLS = new Set(['read', 'write', 'edit', 'glob', 'grep', 'bash', 'todo']);

/** Built-in default allow list used by settings — not applied inside the engine itself. */
export const DEFAULT_ALLOW_RULES = ['Read', 'Glob', 'Grep', 'Todo'];
