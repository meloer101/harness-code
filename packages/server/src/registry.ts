/**
 * `SessionRegistry` — the workspace's live sessions plus a view over the ones
 * on disk. One registry per server (one `cwd`). It owns the `SessionHost`
 * lifecycle: create a new session, open (resuming from disk when it is not
 * already live), close one, or shut them all down.
 *
 * Session config assembly is injected as `buildConfig` so the server and the
 * CLI build sessions identically (via core's `buildSessionConfig`), and so
 * tests and `--mock` can substitute a `ScriptedProvider`.
 */

import { AgentSession } from '@harness-code/core';
import { listSessionIds, loadTranscript, readSessionSummary } from '@harness-code/core';
import type { AgentSessionConfig, PermissionMode } from '@harness-code/core';
import type { SessionSnapshot, SessionSummary } from '@harness-code/protocol';

import { SessionHost } from './host.js';

/** Builds an `AgentSessionConfig` for a new or resumed session. */
export type SessionConfigFactory = (opts: {
  model?: string;
  mode?: PermissionMode;
  resumeId?: string;
}) => Promise<AgentSessionConfig>;

export interface SessionRegistryOptions {
  cwd: string;
  agentDir: string;
  buildConfig: SessionConfigFactory;
  /** Defaults for `session.preview` when the session is not live. */
  previewDefaults: () => Promise<{ modelRef: string; mode: PermissionMode }>;
}

/** Thrown when `session.preview` names a session with no on-disk transcript. */
export class SessionPreviewNotFoundError extends Error {
  constructor(id: string) {
    super(`no session on disk "${id}"`);
    this.name = 'SessionPreviewNotFoundError';
  }
}

export class SessionRegistry {
  readonly #agentDir: string;
  readonly #buildConfig: SessionConfigFactory;
  readonly #previewDefaults: SessionRegistryOptions['previewDefaults'];
  readonly #hosts = new Map<string, SessionHost>();

  constructor(opts: SessionRegistryOptions) {
    this.#agentDir = opts.agentDir;
    this.#buildConfig = opts.buildConfig;
    this.#previewDefaults = opts.previewDefaults;
  }

  get(id: string): SessionHost | undefined {
    return this.#hosts.get(id);
  }

  /**
   * Every session on disk merged with live in-memory state (live/running/
   * pending), plus any live session not yet flushed to disk, newest first.
   */
  async list(): Promise<SessionSummary[]> {
    const onDisk = await listSessionIds(this.#agentDir);
    const rows = new Map<string, SessionSummary>();
    for (const { id } of onDisk) {
      try {
        const summary = await readSessionSummary(this.#agentDir, id);
        rows.set(id, { ...summary, live: false, running: false, pending: false });
      } catch {
        // Vanished or unreadable between listing and reading — skip it.
      }
    }
    for (const [id, host] of this.#hosts) {
      const existing = rows.get(id);
      if (existing) {
        existing.live = true;
        existing.running = host.running;
        existing.pending = host.pending;
      } else {
        rows.set(id, {
          id,
          mtimeMs: Date.now(),
          title: '(new session)',
          live: true,
          running: host.running,
          pending: host.pending,
        });
      }
    }
    return [...rows.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
  }

  async create(opts: { model?: string; mode?: PermissionMode }): Promise<SessionSnapshot> {
    const host = await this.#spawn({ ...opts });
    return host.snapshot();
  }

  /** Return the live snapshot if the session is in memory, else resume from disk. */
  async open(opts: { id: string }): Promise<SessionSnapshot> {
    const live = this.#hosts.get(opts.id);
    if (live) return live.snapshot();
    const host = await this.#spawn({ resumeId: opts.id });
    return host.snapshot();
  }

  /**
   * Cheap snapshot for the UI: live host when in memory, else transcript from
   * disk without spawning `AgentSession` (no MCP connect).
   */
  async preview(opts: { id: string }): Promise<SessionSnapshot> {
    const live = this.#hosts.get(opts.id);
    if (live) return live.snapshot();
    try {
      const transcript = await loadTranscript(this.#agentDir, opts.id);
      const { modelRef, mode } = await this.#previewDefaults();
      return {
        id: opts.id,
        modelRef,
        mode,
        transcript,
        running: false,
        lastSeq: 0,
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') throw new SessionPreviewNotFoundError(opts.id);
      throw err;
    }
  }

  async close(id: string): Promise<void> {
    const host = this.#hosts.get(id);
    if (!host) return;
    this.#hosts.delete(id);
    await host.close();
  }

  async shutdown(): Promise<void> {
    const hosts = [...this.#hosts.values()];
    this.#hosts.clear();
    await Promise.all(hosts.map((h) => h.close()));
  }

  async #spawn(opts: { model?: string; mode?: PermissionMode; resumeId?: string }): Promise<SessionHost> {
    const config = await this.#buildConfig(opts);
    const host = new SessionHost({ agentDir: this.#agentDir });
    const session = await AgentSession.create({
      ...config,
      askHandler: host.ask,
      confirm: host.confirm,
      onEvent: host.onAgentEvent,
      onNotice: host.onNotice,
    });
    host.attach(session, config.model.ref);
    this.#hosts.set(host.id, host);
    return host;
  }
}
