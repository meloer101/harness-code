/**
 * One-shot frontend: build a session, run a single turn, render it, exit.
 * Scriptable and non-interactive by construction — this is what `hc "task"`,
 * `hc -p "…"`, `--output-format json` and piped stdin all land in.
 */

import { AgentSession, ProviderError, addUsage } from '@harness-code/core';
import type { AgentRunResult, AgentSessionConfig, Usage } from '@harness-code/core';
import { isErrorStop } from './format.js';
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

  // Completed model calls, tallied from `turn_end`: when `runTurn` throws, its
  // result is lost, and this is all that is left to report the run with.
  let turns = 0;
  let runUsage: Usage | undefined;

  try {
    let result: AgentRunResult;
    try {
      session = await AgentSession.create({
        ...opts.config,
        ...(askHandler ? { askHandler } : {}),
        onEvent: (e) => {
          if (e.type === 'turn_end') {
            turns++;
            runUsage = runUsage ? addUsage(runUsage, e.usage) : e.usage;
          }
          opts.sink.event(e);
        },
        onNotice: (n) => opts.sink.notice(n),
      });
      result = await session.runTurn(opts.prompt);
    } catch (err) {
      // `sessionUsage` only holds sub-agent spend until `runTurn` returns, so
      // the two never overlap.
      const prior = session?.sessionUsage;
      const usage = prior && runUsage ? addUsage(prior, runUsage) : (runUsage ?? prior);
      const context = session?.contextSnapshot;
      opts.sink.fail({
        sessionId: session?.id ?? '',
        turns,
        ...(usage ? { usage } : {}),
        ...(context ? { context } : {}),
        error: {
          message: err instanceof Error ? err.message : String(err),
          ...(err instanceof ProviderError ? { kind: err.kind } : {}),
        },
      });
      throw err;
    }

    opts.sink.turn(opts.config.model.ref, result, session.contextSnapshot);
    opts.sink.finish({
      sessionId: session.id,
      stopReason: result.stopReason,
      turns: result.turns,
      usage: session.sessionUsage,
      ...(isErrorStop(result.stopReason) ? { isError: true } : {}),
    });
  } finally {
    prompter?.close();
    await session?.close();
  }
}
