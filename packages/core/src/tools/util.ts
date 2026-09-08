export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** One-line summary of what a tool call would do, for approval prompts and tool cards. */
export function describeToolInput(toolName: string, input: unknown): string {
  const rec = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  if (toolName.toLowerCase() === 'bash' && typeof rec.command === 'string') return rec.command;
  if (typeof rec.path === 'string') return rec.path;
  return JSON.stringify(input);
}
