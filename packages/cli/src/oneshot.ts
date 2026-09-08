/**
 * One-shot frontend: build a session, run a single turn, render it, exit.
 * Scriptable and non-interactive by construction — this is what `hc "task"`,
 * `hc -p "…"`, `--output-format json` and piped stdin all land in.
 */

import { AgentSession } from '@harness-code/core';
import type { AgentSessionConfig } from '@harness-code/core';
import { interactiveAsk } from './output.js';
import type { OutputSink, TextSink } from './output.js';
import { createPrompter } from './prompter.js';

export interface OneshotOptions {
  config: AgentSessionConfig;
  prompt: string;
  sink: OutputSink;
  /** True when a human is present to answer permission `ask` verdicts. */
  interactive: boolean;
}

export async function runOneshot(opts: OneshotOptions): Promise<void> {
  let session: AgentSession | undefined;
  const prompter = opts.interactive ? createPrompter() : undefined;
  const askHandler =
    opts.interactive && prompter
      ? interactiveAsk(
          () => session!,
          prompter,
          opts.sink as TextSink,
        )
      : undefined;

  session = await AgentSession.create({
    ...opts.config,
    ...(askHandler ? { askHandler } : {}),
    onEvent: (e) => opts.sink.event(e),
    onNotice: (n) => opts.sink.notice(n),
  });

  try {
    const result = await session.runTurn(opts.prompt);
    opts.sink.turn(opts.config.model.ref, result, session.contextSnapshot);
    opts.sink.finish({
      sessionId: session.id,
      stopReason: result.stopReason,
      turns: result.turns,
      usage: session.sessionUsage,
    });
  } finally {
    prompter?.close();
    await session.close();
  }
}
