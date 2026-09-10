/**
 * Context compaction.
 *
 * Mechanism follows Claude Code: at a token-pressure threshold, hand the oldest
 * span of history to the model for a structured summary, then continue with
 * `[original goal + digest]` followed by the last few turns kept verbatim.
 *
 * Digest *content* follows Manus: beyond task state (decisions, files touched,
 * open problems) it distills the working style — how the user and agent have
 * been collaborating, the code / tool / output conventions in play — so that
 * behaviour survives the compaction, not just facts. The static baseline (the
 * agent's own conventions block) is passed in; the digest records only the
 * deviations from it, which keeps it small.
 *
 * `compactMessages` and the split helpers are pure and unit-tested;
 * `createCompactor` wires them to a provider and returns an `onCompact` hook.
 */

import type { AgentHooks } from '../agent/hooks.js';
import type { Message, Provider } from '../provider/types.js';
import { textOf } from '../provider/types.js';
import { errorMessage } from '../tools/util.js';
import { flattenRequestText, heuristicTokenCount } from './tokenizer.js';

/** Separates the verbatim original goal from the digest inside the merged head. */
export const COMPACTION_MARKER = '\n\n---\n[此前对话已压缩 · compacted]\n';

export const DEFAULT_KEEP_TURNS = 3;
export const DEFAULT_MIN_COMPACT_TOKENS = 2000;
export const DEFAULT_DIGEST_TOKEN_BUDGET = 1800;

/** Recent tool-output tokens kept verbatim when pruning before a full summary. */
export const DEFAULT_PRUNE_PROTECT_TOKENS = 40_000;
/** Minimum reclaimable tokens before prune actually rewrites history. */
export const DEFAULT_PRUNE_MIN_RECLAIM_TOKENS = 20_000;
/** Tool names whose results are never pruned (e.g. skill manifests). */
export const DEFAULT_PRUNE_PROTECTED_TOOLS = ['skill'] as const;

/** Marker prefix for a pruned tool_result — also used to skip re-pruning. */
export const PRUNED_TOOL_RESULT_PREFIX = '[pruned tool output:';


// ---------------------------------------------------------------------------
// Pure splitting / assembly
// ---------------------------------------------------------------------------

export interface CompactionSplit {
  /** Messages to be summarized away. */
  middle: Message[];
  /** Trailing turns kept verbatim. */
  tail: Message[];
  /** Number of turns in `tail`. */
  keptTurns: number;
}

/**
 * Group everything after the head into turns. A turn begins at an assistant
 * message or a fresh user *text* prompt; a user message carrying `tool_result`
 * blocks attaches to the group before it — so an assistant `tool_use` and its
 * result are never split across a cut.
 */
function groupTurns(rest: readonly Message[]): Message[][] {
  const groups: Message[][] = [];
  let cur: Message[] = [];
  for (const m of rest) {
    const isToolResult = m.role === 'user' && m.content.some((b) => b.type === 'tool_result');
    if (isToolResult) {
      cur.push(m);
    } else {
      if (cur.length > 0) groups.push(cur);
      cur = [m];
    }
  }
  if (cur.length > 0) groups.push(cur);
  return groups;
}

/**
 * Split `messages` into `[head] + middle + tail`, cutting only on turn
 * boundaries. Returns `undefined` when there is nothing worth compacting
 * (too few turns, or an empty middle).
 */
export function splitForCompaction(
  messages: readonly Message[],
  keepTurns: number,
): CompactionSplit | undefined {
  if (messages.length < 2) return undefined;
  const groups = groupTurns(messages.slice(1));
  if (groups.length <= keepTurns) return undefined;
  const tailGroups = groups.slice(groups.length - keepTurns);
  const middle = groups.slice(0, groups.length - keepTurns).flat();
  if (middle.length === 0) return undefined;
  return { middle, tail: tailGroups.flat(), keptTurns: tailGroups.length };
}

/** Pull the verbatim goal and any prior digest back out of a (possibly already compacted) head. */
export function parseGoalAndPriorDigest(head: Message): { goal: string; priorDigest?: string } {
  const text = textOf(head.content);
  const i = text.indexOf(COMPACTION_MARKER);
  if (i === -1) return { goal: text };
  return { goal: text.slice(0, i), priorDigest: text.slice(i + COMPACTION_MARKER.length) };
}

/**
 * Assemble the compacted history: one user message holding the verbatim goal
 * plus the fresh digest, then the kept tail. Merging into the head (rather than
 * inserting a new message) keeps roles alternating in the common case where the
 * tail starts with an assistant message.
 */
export function compactMessages(goal: string, digest: string, tail: readonly Message[]): Message[] {
  const mergedHead: Message = {
    role: 'user',
    content: [{ type: 'text', text: `${goal.trimEnd()}${COMPACTION_MARKER}${digest.trim()}` }],
  };
  return [mergedHead, ...tail];
}

// ---------------------------------------------------------------------------
// Cheap prune: clear old tool outputs before a full LLM summary
// ---------------------------------------------------------------------------

export interface PruneToolOutputsOptions {
  /** Recent tool-output tokens kept verbatim. Default 40_000. */
  protectTokens?: number;
  /** Skip rewrite when reclaimable tokens are below this. Default 20_000. */
  minReclaimTokens?: number;
  /** Tool names whose results are never pruned. Default `['skill']`. */
  protectedTools?: readonly string[];
}

export interface PruneToolOutputsResult {
  messages: Message[];
  /** Heuristic tokens removed from tool_result bodies (0 ⇒ messages unchanged). */
  reclaimedTokens: number;
}

/**
 * Clear old tool outputs from the recent-past, keeping the newest ~protectTokens
 * of tool output (and any protected tools) intact. Pure: returns the original
 * array reference when nothing is worth reclaiming.
 *
 * Walks newest → oldest. A tool_result whose cumulative (newest-first) token
 * count still fits in the protect window is kept; older ones become a short
 * placeholder. Protected tools (e.g. `skill`) are always kept.
 */
export function pruneToolOutputs(
  messages: readonly Message[],
  opts: PruneToolOutputsOptions = {},
): PruneToolOutputsResult {
  const protectTokens = opts.protectTokens ?? DEFAULT_PRUNE_PROTECT_TOKENS;
  const minReclaim = opts.minReclaimTokens ?? DEFAULT_PRUNE_MIN_RECLAIM_TOKENS;
  const protectedTools = new Set(opts.protectedTools ?? DEFAULT_PRUNE_PROTECTED_TOOLS);

  const toolNameById = new Map<string, string>();
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    for (const b of msg.content) {
      if (b.type === 'tool_use') toolNameById.set(b.id, b.name);
    }
  }

  // Collect (msgIdx, blockIdx, tokens, toolName) for every tool_result, newest last.
  type Hit = { msgIdx: number; blockIdx: number; tokens: number; toolName: string; content: string };
  const hits: Hit[] = [];
  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi]!;
    if (msg.role !== 'user') continue;
    for (let bi = 0; bi < msg.content.length; bi++) {
      const b = msg.content[bi]!;
      if (b.type !== 'tool_result') continue;
      if (b.content.startsWith(PRUNED_TOOL_RESULT_PREFIX)) continue;
      const toolName = toolNameById.get(b.toolUseId) ?? 'unknown';
      hits.push({
        msgIdx: mi,
        blockIdx: bi,
        tokens: heuristicTokenCount(b.content),
        toolName,
        content: b.content,
      });
    }
  }

  // Newest → oldest: keep filling the protect window; once full, prune older.
  let protectedSoFar = 0;
  const toPrune = new Set<string>(); // `${msgIdx}:${blockIdx}`
  let reclaimable = 0;
  for (let i = hits.length - 1; i >= 0; i--) {
    const hit = hits[i]!;
    const key = `${hit.msgIdx}:${hit.blockIdx}`;
    if (protectedTools.has(hit.toolName)) continue;
    if (protectedSoFar >= protectTokens) {
      toPrune.add(key);
      reclaimable += hit.tokens;
      continue;
    }
    protectedSoFar += hit.tokens;
  }

  if (reclaimable < minReclaim || toPrune.size === 0) {
    return { messages: messages as Message[], reclaimedTokens: 0 };
  }

  const out: Message[] = messages.map((msg, mi) => {
    if (msg.role !== 'user') return msg;
    let changed = false;
    const content = msg.content.map((b, bi) => {
      if (b.type !== 'tool_result') return b;
      if (!toPrune.has(`${mi}:${bi}`)) return b;
      changed = true;
      const toolName = toolNameById.get(b.toolUseId) ?? 'unknown';
      const chars = b.content.length;
      return {
        ...b,
        content:
          `${PRUNED_TOOL_RESULT_PREFIX} ${toolName}, ${chars} chars] ` +
          `Cleared to free context. Re-call the tool if you still need the output.`,
      };
    });
    return changed ? { ...msg, content } : msg;
  });

  return { messages: out, reclaimedTokens: reclaimable };
}

// ---------------------------------------------------------------------------
// Digest prompt
// ---------------------------------------------------------------------------

function digestSystemPrompt(conventions: string, budget: number): string {
  return `你在压缩一个 coding agent 的会话历史。把给定的历史片段浓缩成一份结构化 digest，让 agent 读完能无缝继续工作。

严格输出下面两个小节的 markdown，不要有额外前言或结语：

## 任务状态
- 原始目标：<一字不差保留用户的原始目标>
- 进展与关键决策：<做了什么、为什么这么做；架构决策和取舍必须留下>
- 触碰过的文件：<每行 "路径 — 改了什么 / 为什么读"；可以丢文件正文，但一定保留路径>
- 未决事项 / 已知问题 / 下一步
- 关键代码事实：<函数签名、常量名、约定、跑过的命令；标识符保留原文>

## 协作与风格备忘
下面是这个 agent 的基线工作约定：
<baseline>
${conventions}
</baseline>
只记录**观察到的、相对基线的偏差**，四个维度各一行；某维度没有偏差就写"无偏差"：
- 与用户协作：<被用户纠正过的、或明确表达过的偏好：语言、节奏、批准习惯等>
- 代码风格：<相对基线的偏差>
- 工具调用：<相对基线的偏差>
- 输出风格：<相对基线的偏差>

保留因果链、已经建立/修改的环境状态、前置条件、以及影响后续决策的线索。具体，不要泛泛而谈。整份 digest 控制在约 ${budget} token 以内。`;
}

function digestUserPrompt(goal: string, priorDigest: string | undefined, middleText: string): string {
  const parts = [`原始目标：\n${goal.trim()}`];
  if (priorDigest && priorDigest.trim() !== '') {
    parts.push(`上一版 digest（在此基础上更新，不要丢信息）：\n${priorDigest.trim()}`);
  }
  parts.push(`需要压缩的历史片段：\n${middleText}`);
  return parts.join('\n\n---\n\n');
}

// ---------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------

export interface CompactorOptions {
  provider: Provider;
  /** Bare model id for the summarization call. */
  model: string;
  /** The agent's own conventions block — the style baseline the digest deviates from. */
  conventions: string;
  keepTurns?: number;
  minCompactTokens?: number;
  digestTokenBudget?: number;
  /**
   * Run a free prune of old tool outputs before asking the model for a digest.
   * Default true — only fires when `onCompact` has already been triggered, so it
   * does not add an extra prefix-cache invalidation beyond the summary itself.
   */
  pruneBeforeSummary?: boolean;
  pruneProtectTokens?: number;
  pruneMinReclaimTokens?: number;
  prunedToolsExempt?: readonly string[];
  /** Called with a one-line reason whenever compaction is skipped (empty middle, failed call). */
  onSkip?(reason: string): void;
}

/**
 * Build an `onCompact` hook. Optionally prunes old tool outputs first, then
 * splits history, asks the model for a digest, and returns the compacted list.
 * Any failure is swallowed (logged via `onSkip`) and reported as "no compaction"
 * — the loop's `context_limit` stop remains the safety net, so a broken
 * summarizer degrades gracefully instead of killing the session.
 */
export function createCompactor(opts: CompactorOptions): NonNullable<AgentHooks['onCompact']> {
  const keepTurns = opts.keepTurns ?? DEFAULT_KEEP_TURNS;
  const minCompactTokens = opts.minCompactTokens ?? DEFAULT_MIN_COMPACT_TOKENS;
  const budget = opts.digestTokenBudget ?? DEFAULT_DIGEST_TOKEN_BUDGET;
  const pruneBefore = opts.pruneBeforeSummary !== false;

  return async (messages, _pressure, ctx) => {
    let working: readonly Message[] = messages;
    let prunedReclaimed = 0;
    if (pruneBefore) {
      const pruned = pruneToolOutputs(messages, {
        ...(opts.pruneProtectTokens !== undefined
          ? { protectTokens: opts.pruneProtectTokens }
          : {}),
        ...(opts.pruneMinReclaimTokens !== undefined
          ? { minReclaimTokens: opts.pruneMinReclaimTokens }
          : {}),
        ...(opts.prunedToolsExempt !== undefined
          ? { protectedTools: opts.prunedToolsExempt }
          : {}),
      });
      if (pruned.reclaimedTokens > 0) {
        working = pruned.messages;
        prunedReclaimed = pruned.reclaimedTokens;
      }
    }

    const head = working[0];
    if (!head) return undefined;

    const split = splitForCompaction(working, keepTurns);
    if (!split) {
      if (prunedReclaimed > 0) return { messages: [...working] };
      opts.onSkip?.('compaction skipped: not enough history to compact');
      return undefined;
    }

    const middleText = flattenRequestText({ messages: split.middle });
    if (heuristicTokenCount(middleText) < minCompactTokens) {
      if (prunedReclaimed > 0) return { messages: [...working] };
      opts.onSkip?.('compaction skipped: compactable history below the minimum');
      return undefined;
    }

    const { goal, priorDigest } = parseGoalAndPriorDigest(head);

    try {
      const res = await opts.provider.complete({
        model: opts.model,
        system: [{ id: 'compactor', text: digestSystemPrompt(opts.conventions, budget) }],
        messages: [
          { role: 'user', content: [{ type: 'text', text: digestUserPrompt(goal, priorDigest, middleText) }] },
        ],
        temperature: 0,
        maxOutputTokens: Math.ceil(budget * 1.5),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      const digest = textOf(res.content).trim();
      if (digest === '') {
        if (prunedReclaimed > 0) return { messages: [...working] };
        opts.onSkip?.('compaction skipped: summarizer returned nothing');
        return undefined;
      }
      return {
        messages: compactMessages(goal, digest, split.tail),
        usage: res.usage,
        keptTurns: split.keptTurns,
      };
    } catch (err) {
      if (prunedReclaimed > 0) return { messages: [...working] };
      opts.onSkip?.(`compaction skipped: ${errorMessage(err)}`);
      return undefined;
    }
  };
}
