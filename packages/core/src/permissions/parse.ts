import type { PermissionRule } from './types.js';

const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * Parse a Claude Code-style `Tool` / `Tool(specifier)` rule.
 * Tool names are stored lowercase so `Bash` and `bash` are the same rule.
 */
export function parseRule(raw: string): PermissionRule {
  const text = raw.trim();
  if (!text) {
    throw new Error('Permission rule is empty');
  }

  const open = text.indexOf('(');
  if (open === -1) {
    if (!TOOL_NAME.test(text)) {
      throw new Error(`Invalid permission rule "${raw}": tool name is not valid`);
    }
    return { tool: text.toLowerCase(), raw: text };
  }

  if (!text.endsWith(')')) {
    throw new Error(`Invalid permission rule "${raw}": missing closing parenthesis`);
  }
  if (open === 0) {
    throw new Error(`Invalid permission rule "${raw}": missing tool name`);
  }

  const tool = text.slice(0, open);
  const pattern = text.slice(open + 1, -1);
  if (!TOOL_NAME.test(tool)) {
    throw new Error(`Invalid permission rule "${raw}": tool name is not valid`);
  }
  if (pattern.trim() === '') {
    throw new Error(`Invalid permission rule "${raw}": empty specifier`);
  }

  return { tool: tool.toLowerCase(), pattern, raw: text };
}
