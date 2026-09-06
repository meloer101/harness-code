import { describe, expect, it } from 'vitest';

import { SessionState } from '../agent/session.js';
import { todoTool } from './todo.js';
import type { ToolContext } from './types.js';

describe('todoTool', () => {
  it('stores the list in session state and renders it', async () => {
    const session = new SessionState();
    const ctx: ToolContext = { cwd: '/tmp', session };
    const result = await todoTool.execute(
      {
        todos: [
          { id: '1', content: 'write tests', status: 'completed' },
          { id: '2', content: 'ship it', status: 'in_progress' },
          { id: '3', content: 'celebrate', status: 'pending' },
        ],
      },
      ctx,
    );
    expect(result.content).toBe('[x] write tests\n[~] ship it\n[ ] celebrate');
    expect(session.getTodos()).toHaveLength(3);
  });

  it('renders an empty list', async () => {
    const session = new SessionState();
    const ctx: ToolContext = { cwd: '/tmp', session };
    const result = await todoTool.execute({ todos: [] }, ctx);
    expect(result.content).toBe('(empty)');
  });
});
