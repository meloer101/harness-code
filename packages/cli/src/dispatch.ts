/**
 * Frontend dispatch: which of `tui` / `oneshot` / `repl` runs, and how a prompt
 * is assembled from the CLI arg plus piped stdin.
 *
 * Pure and table-testable — no reads of `process` beyond what the caller passes
 * in, so the decision matrix has one test per cell.
 */

export type Frontend = 'tui' | 'oneshot' | 'repl';
export type OutputFormat = 'text' | 'json' | 'stream-json';

export interface DispatchInput {
  hasPromptArg: boolean;
  print: boolean;
  outputFormat: OutputFormat;
  stdinIsTty: boolean;
  stdoutIsTty: boolean;
  env: NodeJS.ProcessEnv;
  platform?: string;
}

/**
 * Scriptability first: anything that is a one-shot request (a prompt argument,
 * `-p`, a non-text output format, or piped stdin) never enters the TUI/REPL.
 * Only a bare `hc` on a real terminal reaches the TUI, and only a dumb
 * terminal / opt-out falls back to the readline REPL.
 */
export function decideFrontend(d: DispatchInput): Frontend {
  if (d.hasPromptArg || d.print || d.outputFormat !== 'text' || !d.stdinIsTty) {
    return 'oneshot';
  }
  const platform = d.platform ?? process.platform;
  const tui =
    d.stdinIsTty &&
    d.stdoutIsTty &&
    d.env.HC_NO_TUI !== '1' &&
    d.env.TERM !== 'dumb' &&
    !(platform === 'win32' && !d.env.WT_SESSION);
  return tui ? 'tui' : 'repl';
}

/** Read piped stdin to a string. Returns '' when stdin is a TTY (nothing piped). */
export async function readStdin(isTTY = process.stdin.isTTY): Promise<string> {
  if (isTTY) return '';
  let data = '';
  for await (const chunk of process.stdin) data += String(chunk);
  return data;
}

/**
 * Combine the CLI prompt argument and piped stdin. When both are present the
 * argument is the instruction and stdin is attached as a tagged block below it
 * (instruction first, so the model reads the ask before the data); stdin alone
 * is the whole prompt. Returns `undefined` when there is nothing to run.
 */
export function buildPrompt(
  promptArg: string | undefined,
  stdin: string | undefined,
): string | undefined {
  const arg = promptArg?.trim() ?? '';
  const piped = stdin?.trim() ?? '';
  if (arg !== '' && piped !== '') return `${arg}\n\n<stdin>\n${piped}\n</stdin>`;
  if (arg !== '') return arg;
  if (piped !== '') return piped;
  return undefined;
}
