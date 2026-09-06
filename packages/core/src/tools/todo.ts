import { z } from 'zod';

import type { TodoStatus } from '../agent/session.js';
import type { ToolSpec } from './types.js';

const schema = z.object({
  todos: z
    .array(
      z.object({
        id: z.string(),
        content: z.string(),
        status: z.enum(['pending', 'in_progress', 'completed']),
      }),
    )
    .describe('The full task list, replacing whatever was there before.'),
});

export const todoTool: ToolSpec<z.infer<typeof schema>> = {
  name: 'todo',
  description:
    'Update the task list for this session, for tracking progress on long, multi-step work. ' +
    'Pass the full list each time to replace it.',
  schema,
  readOnly: false,
  concurrencySafe: false,
  async execute(input, ctx) {
    ctx.session.setTodos(input.todos);
    const rendered =
      input.todos.length > 0
        ? input.todos.map((t) => `[${statusMark(t.status)}] ${t.content}`).join('\n')
        : '(empty)';
    return { content: rendered };
  },
};

function statusMark(status: TodoStatus): string {
  switch (status) {
    case 'completed':
      return 'x';
    case 'in_progress':
      return '~';
    default:
      return ' ';
  }
}
