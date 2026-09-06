export * from './types.js';
export * from './registry.js';
export * from './read.js';
export * from './write.js';
export * from './edit.js';
export * from './glob.js';
export * from './grep.js';
export * from './bash.js';
export * from './todo.js';

import { bashTool } from './bash.js';
import { editTool } from './edit.js';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';
import { readTool } from './read.js';
import { todoTool } from './todo.js';
import type { AnyToolSpec } from './types.js';
import { writeTool } from './write.js';

export function builtinTools(): AnyToolSpec[] {
  return [readTool, writeTool, editTool, globTool, grepTool, bashTool, todoTool] as AnyToolSpec[];
}
