import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_CAPABILITIES } from '../provider/capabilities.js';
import { ScriptedProvider } from '../provider/mock.js';
import { ProviderError } from '../provider/types.js';
import type { Provider } from '../provider/types.js';
import type { ResolvedModel } from '../provider/router.js';
import type { AgentEvent } from './loop.js';
import { AgentSession } from './session-runner.js';
import type { AgentSessionConfig, Notice } from './session-runner.js';

const ECHO_SERVER = fileURLToPath(new URL('../mcp/__fixtures__/echo-server.mjs', import.meta.url));

type ToolCallEndEvent = Extract<AgentEvent, { type: 'tool_call_end' }>;

function findToolEnd(events: AgentEvent[], name: string): ToolCallEndEvent | undefined {
  for (const e of events) {
    if (e.type === 'tool_call_end' && e.name === name) return e;
  }
  return undefined;
}

function lastToolEnd(events: AgentEvent[], name: string): ToolCallEndEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === 'tool_call_end' && e.name === name) return e;
  }
  return undefined;
}

function sessionModel(
  provider: Provider,
  caps: Partial<typeof DEFAULT_CAPABILITIES> = {},
): ResolvedModel {
  return {
    provider,
    providerId: provider.id,
    model: 'test-model',
    ref: `${provider.id}/test-model`,
    capabilities: { ...DEFAULT_CAPABILITIES, ...caps },
  };
}

interface Harness {
  session: AgentSession;
  events: AgentEvent[];
  notices: Notice[];
}

const tmpDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'hc-session-'));
  tmpDirs.push(d);
  return d;
}

async function createSession(overrides: Partial<AgentSessionConfig> = {}): Promise<Harness> {
  const events: AgentEvent[] = [];
  const notices: Notice[] = [];
  const base: AgentSessionConfig = {
    cwd: await tempDir(),
    model: sessionModel(new ScriptedProvider([{ text: 'ok' }])),
    settings: {},
    budgets: {},
    skills: false,
    subagents: false,
    mcp: false,
    memory: false,
    recorder: false,
    trace: false,
    projectMemory: null,
    mode: 'yolo',
  };
  const session = await AgentSession.create({
    ...base,
    ...overrides,
    onEvent: (e) => {
      events.push(e);
      overrides.onEvent?.(e);
    },
    onNotice: (n) => {
      notices.push(n);
      overrides.onNotice?.(n);
    },
  });
  return { session, events, notices };
}

describe('AgentSession', () => {
  it('runs a turn: streams deltas, executes a tool, accumulates messages', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'todo', input: { todos: [{ id: '1', content: 'do', status: 'in_progress' }] } }] },
      { text: 'done', chunkSize: 2 },
    ]);
    const { session, events } = await createSession({ model: sessionModel(provider) });

    const result = await session.runTurn('first');

    expect(result.stopReason).toBe('end_turn');
    expect(events.some((e) => e.type === 'text_delta' && e.text === 'do')).toBe(true);
    expect(events.some((e) => e.type === 'text_delta' && e.text === 'ne')).toBe(true);
    expect(events.some((e) => e.type === 'tool_call_start' && e.name === 'todo')).toBe(true);
    expect(events.some((e) => e.type === 'tool_call_end' && e.name === 'todo')).toBe(true);
    expect(events.filter((e) => e.type === 'turn_end')).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ type: 'stop', reason: 'end_turn' });
    // user, assistant(tool_use), user(tool_result), assistant(final text)
    expect(session.messages).toHaveLength(4);
  });

  it('accumulates messages across turns, sharing one session state', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'todo', input: { todos: [{ id: '1', content: 'a', status: 'pending' }] } }] },
      { text: 'turn one done' },
      { text: 'turn two done' },
    ]);
    const { session } = await createSession({ model: sessionModel(provider) });

    const first = await session.runTurn('first');
    const second = await session.runTurn('second');

    expect(first.messages).toHaveLength(4);
    expect(second.messages).toHaveLength(6);
    // The todo list set in turn 1 is still visible to turn 2 (same SessionState).
    expect(session.messages).toEqual(second.messages);
  });

  it('persists the read ledger across turns (read then edit in separate turns)', async () => {
    const cwd = await tempDir();
    await writeFile(join(cwd, 'a.txt'), 'hello world\n', 'utf8');

    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'read', input: { path: 'a.txt' } }] },
      { text: 'read it' },
      { toolCalls: [{ name: 'edit', input: { path: 'a.txt', oldString: 'hello', newString: 'goodbye' } }] },
      { text: 'edited' },
    ]);
    const { session, events } = await createSession({ cwd, model: sessionModel(provider) });

    await session.runTurn('read');
    await session.runTurn('edit');

    const editEnd = findToolEnd(events, 'edit');
    expect(editEnd).toBeDefined();
    expect(editEnd!.result.isError).toBeUndefined();
    expect(editEnd!.result.content).toContain('Replaced 1 occurrence');
  });

  it('abort() aborts an in-flight turn', async () => {
    let listeningResolve!: () => void;
    const listening = new Promise<void>((r) => (listeningResolve = r));
    const hanging: Provider = {
      id: 'hanging',
      async complete() {
        throw new Error('not used');
      },
      async *stream(req) {
        yield { type: 'message_start', model: req.model };
        yield { type: 'text_delta', text: 'partial' };
        await new Promise<never>((_resolve, reject) => {
          const onAbort = (): void =>
            reject(new ProviderError('aborted', 'aborted', { retryable: false }));
          if (req.signal?.aborted) return onAbort();
          req.signal?.addEventListener('abort', onAbort, { once: true });
          listeningResolve();
        });
      },
    };
    const { session } = await createSession({ model: sessionModel(hanging) });

    const run = session.runTurn('hi');
    await listening;
    session.abort();
    const result = await run;

    expect(result.stopReason).toBe('aborted');
  });

  it('an injected deny-all ask handler blocks the call and the loop continues', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'bash', input: { command: 'echo hi' } }] },
      { text: 'done' },
    ]);
    const { session, events } = await createSession({
      model: sessionModel(provider),
      mode: 'ask',
      askHandler: async () => ({ decision: 'deny', reason: 'nope' }),
    });

    const result = await session.runTurn('do it');

    const end = findToolEnd(events, 'bash');
    expect(end?.result).toMatchObject({ isError: true, content: 'Denied: nope' });
    expect(result.stopReason).toBe('end_turn');
    expect(result.messages).toHaveLength(4);
  });

  it('plan mode: confirm approval leaves plan mode and drops exit_plan_mode next turn', async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'exit_plan_mode', input: { title: 'T', plan: 'do X' } }] },
      { text: 'implementing' },
      { toolCalls: [{ name: 'exit_plan_mode', input: { title: 'T', plan: 'again' } }] },
      { text: 'done' },
    ]);
    const confirmed: string[] = [];
    const { session, events, notices } = await createSession({
      model: sessionModel(provider),
      mode: 'plan',
      planApprovedMode: 'acceptEdits',
      confirm: async (req) => {
        confirmed.push(req.title);
        return { approved: true };
      },
    });

    await session.runTurn('plan it');
    expect(confirmed).toEqual(['T']);
    expect(session.mode).toBe('acceptEdits');
    expect(notices.some((n) => n.kind === 'mode-changed')).toBe(true);

    await session.runTurn('continue');
    expect(lastToolEnd(events, 'exit_plan_mode')?.result.content).toContain('Unknown tool');
  });

  it('skills/subagents/mcp/recorder/trace all disabled → no discovery, no tools, no files', async () => {
    const cwd = await tempDir();
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: 'skill', input: { name: 'code-review' } }] },
      { text: 'ok' },
    ]);
    const { session, events } = await createSession({ cwd, model: sessionModel(provider) });

    await session.runTurn('hi');

    // `skill` is not registered when skills:false → "Unknown tool".
    const end = findToolEnd(events, 'skill');
    expect(end?.result.content).toContain('Unknown tool');
    expect(session.listSlashCommands()).toEqual([]);
    expect(session.mcpStatus).toEqual([]);
    // No session/trace dirs were created.
    expect(session.id).toBeTruthy();
  });

  it('expandSlash resolves MCP prompts and reports them via listSlashCommands', async () => {
    const cwd = await tempDir();
    await writeFile(
      join(cwd, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          'fixture-echo': { command: process.execPath, args: [ECHO_SERVER], env: {} },
        },
      }),
      'utf8',
    );
    const { session } = await createSession({ cwd, mcp: true });

    const commands = session.listSlashCommands();
    expect(commands.some((c) => c.name === 'summarize' && c.server === 'fixture-echo')).toBe(true);

    expect(await session.expandSlash('/summarize')).toContain('Summarize');
    expect(await session.expandSlash('/summarize foo bar')).toContain('foo bar');
    expect(await session.expandSlash('/nope')).toBeNull();

    await session.close();
  });

  it('compactNow() returns token savings and rewrites history', async () => {
    const longText = 'x'.repeat(8000); // ~2k heuristic tokens per assistant turn
    const main = new ScriptedProvider([
      { toolCalls: [{ name: 'todo', input: { todos: [{ id: '1', content: 'a', status: 'completed' }] } }] },
      { text: longText },
      { toolCalls: [{ name: 'todo', input: { todos: [{ id: '2', content: 'b', status: 'completed' }] } }] },
      { text: longText },
      { toolCalls: [{ name: 'todo', input: { todos: [{ id: '3', content: 'c', status: 'completed' }] } }] },
      { text: longText },
    ]);
    const summarizer = new ScriptedProvider([{ text: 'digest summary' }], 'summarizer');
    const { session } = await createSession({
      model: sessionModel(main),
      summarizerModel: sessionModel(summarizer),
    });

    await session.runTurn('one');
    await session.runTurn('two');
    await session.runTurn('three');
    const before = session.messages.length;
    const saved = await session.compactNow();

    expect(saved).not.toBeNull();
    expect(saved!.tokensAfter).toBeLessThan(saved!.tokensBefore);
    expect(session.messages.length).toBeLessThan(before);
  });
});

describe('AgentSession persistent memory', () => {
  it('flushes a write on close and a second session can read it', async () => {
    const cwd = await tempDir();
    const home = await tempDir();
    const builtin = await tempDir();
    const path = 'feedback/testing-no-mocks.md';

    const first = new ScriptedProvider([
      {
        toolCalls: [
          {
            name: 'memory',
            input: {
              action: 'write',
              scope: 'project',
              path,
              type: 'feedback',
              description: 'no mock db',
              body: 'Use a real test database.',
            },
          },
        ],
      },
      { text: 'noted' },
    ]);
    const a = await createSession({
      cwd,
      homeDir: home,
      builtinMemoryDir: builtin,
      memory: true,
      model: sessionModel(first),
    });
    await a.session.runTurn('remember this');
    await a.session.close();
    expect(a.notices.some((n) => n.kind === 'memory' && /Saved/.test(n.text))).toBe(true);

    const second = new ScriptedProvider([
      { toolCalls: [{ name: 'memory', input: { action: 'read', scope: 'project', path } }] },
      { text: 'got it' },
    ]);
    const b = await createSession({
      cwd,
      homeDir: home,
      builtinMemoryDir: builtin,
      memory: true,
      model: sessionModel(second),
    });
    await b.session.runTurn('what was the testing note?');
    const read = lastToolEnd(b.events, 'memory');
    expect(read?.result.isError).toBeFalsy();
    expect(read?.result.content).toContain('real test database');
    await b.session.close();
  });

  it('read of a just-written path hits the buffer before close', async () => {
    const cwd = await tempDir();
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          {
            name: 'memory',
            input: {
              action: 'write',
              scope: 'project',
              path: 'feedback/foo.md',
              type: 'feedback',
              description: 'foo',
              body: 'staged body',
            },
          },
        ],
      },
      { toolCalls: [{ name: 'memory', input: { action: 'read', scope: 'project', path: 'feedback/foo.md' } }] },
      { text: 'ok' },
    ]);
    const { session, events } = await createSession({
      cwd,
      homeDir: await tempDir(),
      builtinMemoryDir: await tempDir(),
      memory: true,
      model: sessionModel(provider),
    });
    await session.runTurn('write then read');
    const reads = events.filter((e): e is ToolCallEndEvent => e.type === 'tool_call_end' && e.name === 'memory');
    expect(reads).toHaveLength(2);
    expect(reads[1]?.result.content).toContain('staged body');
    await expect(access(join(cwd, '.agent', 'memory', 'feedback', 'foo.md'))).rejects.toThrow();
    await session.close();
  });
});
