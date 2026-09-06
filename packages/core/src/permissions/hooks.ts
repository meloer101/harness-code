import type { AgentHooks } from '../agent/hooks.js';
import { READ_ONLY_TOOLS } from './defaults.js';
import type { PermissionEngine } from './engine.js';
import type { AskHandler } from './types.js';

export const nonInteractiveAskHandler: AskHandler = async ({ reason }) => ({
  decision: 'deny',
  reason: `${reason} Non-interactive mode requires an explicit --allow rule or --mode yolo.`,
});

export function createPermissionHooks(engine: PermissionEngine, ask: AskHandler): AgentHooks {
  return {
    async onBeforeToolCall(call, ctx) {
      const verdict = await engine.evaluate({
        toolName: call.name,
        input: call.input,
        readOnly: READ_ONLY_TOOLS.has(call.name.toLowerCase()),
      });
      if (verdict.decision === 'ask') {
        return ask({
          toolName: call.name,
          input: call.input,
          reason: verdict.reason,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
      }
      return verdict;
    },
  };
}
