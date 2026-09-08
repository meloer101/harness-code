/**
 * REPL frontend: a plain-text back-and-forth over the same `AgentSession`.
 *
 * The fallback when the TUI can't run (dumb terminal, `--no-tui`, old Windows
 * console) and the human bridge for permission `ask` verdicts on a TTY. The
 * read ledger persists across messages because it's the same session object;
 * Ctrl+C aborts an in-flight turn via `session.abort()` without killing the
 * session, and a second Ctrl+C at an idle prompt (or `exit` / Ctrl+D) ends it.
 */

import { createInterface } from 'node:readline';

import { AgentSession } from '@harness-code/core';
import type { AgentSessionConfig } from '@harness-code/core';
import { interactiveAsk } from './output.js';
import type { TextSink } from './output.js';
import { createPrompter } from './prompter.js';

export async function runRepl(config: AgentSessionConfig, sink: TextSink): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  const prompter = createPrompter(rl);

  let session: AgentSession | undefined;
  const askHandler = interactiveAsk(
    () => session!,
    prompter,
    sink,
  );
  session = await AgentSession.create({
    ...config,
    askHandler,
    onEvent: (e) => sink.event(e),
    onNotice: (n) => sink.notice(n),
  });

  sink.dim('type a message, or "exit"/"quit" to leave (Ctrl+D also works)');

  // Serialize lines onto one promise chain: readline fires 'line' back-to-back
  // for already-buffered piped input, and without this a burst would start
  // several turns concurrently and could process "exit" before an earlier
  // message ran.
  let queue: Promise<void> = Promise.resolve();
  let inTurn = false;

  const onSigint = (): void => {
    if (inTurn) session!.abort();
    else rl.close();
  };
  process.on('SIGINT', onSigint);

  async function processLine(line: string): Promise<void> {
    const text = line.trim();
    if (text === '') {
      rl.prompt();
      return;
    }
    if (text === 'exit' || text === 'quit') {
      rl.close();
      return;
    }

    let turnText = text;
    if (text.startsWith('/')) {
      const [cmd] = text.slice(1).split(/\s+/);
      const expanded = await session!.expandSlash(text);
      if (expanded === null) {
        sink.dim(
          `unknown command "/${cmd}". MCP prompts available: ${
            session!.listSlashCommands().map((c) => c.command).join(', ') || '(none)'
          }`,
        );
        rl.prompt();
        return;
      }
      turnText = expanded;
      sink.dim(`/${cmd} → ${expanded.length} chars`);
    }

    inTurn = true;
    try {
      const result = await session!.runTurn(turnText);
      sink.turn(config.model.ref, result, session!.contextSnapshot);
    } catch (err) {
      process.stderr.write(`\x1b[31mhc: ${err instanceof Error ? err.message : String(err)}\x1b[0m\n`);
    } finally {
      inTurn = false;
      rl.prompt();
    }
  }

  rl.prompt();
  rl.on('line', (line) => {
    queue = queue.then(() => processLine(line));
  });

  rl.on('close', () => {
    process.off('SIGINT', onSigint);
    void queue
      .finally(() => session!.close())
      .finally(() => {
        sink.finish({
          sessionId: session!.id,
          stopReason: 'end_turn',
          turns: 0,
          usage: session!.sessionUsage,
        });
        process.exit(0);
      });
  });
}
