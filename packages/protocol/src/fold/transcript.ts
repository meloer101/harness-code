/**
 * Persisted transcript → display entries. Shared (Ink/React-free) so the TUI
 * and the web frontend rebuild a session's history identically — the same
 * reason `foldReducer`/`EventBuffer` live here. The web frontend uses it to
 * hydrate a snapshot; the TUI uses it when `/resume` swaps to another session.
 */

import type { Notice, TranscriptItem } from '@harness-code/core';

import type { Entry, ToolItem } from './reducer.js';

/**
 * Rebuild display entries from the persisted transcript: one `assistant` entry
 * per assistant message, tool results (which ride in the next `user` message)
 * attached back onto their tool cards, compactions as a divider notice.
 */
export function entriesFromTranscript(items: TranscriptItem[]): Entry[] {
  const entries: Entry[] = [];
  const tools = new Map<string, ToolItem>();

  for (const item of items) {
    if (item.type === 'compaction') {
      const notice: Notice = {
        kind: 'compaction',
        level: 'info',
        text: `Context compacted (${item.tokensBefore.toLocaleString()} → ${item.tokensAfter.toLocaleString()} tokens)`,
      };
      entries.push({ kind: 'notice', id: entries.length, notice });
      continue;
    }
    const { message } = item;
    if (message.role === 'assistant') {
      let thinking = '';
      let text = '';
      const entryTools: ToolItem[] = [];
      for (const block of message.content) {
        if (block.type === 'thinking') thinking += block.text;
        else if (block.type === 'text') text += block.text;
        else if (block.type === 'tool_use') {
          const tool: ToolItem = { id: block.id, name: block.name, input: block.input, running: false };
          entryTools.push(tool);
          tools.set(block.id, tool);
        }
      }
      if (thinking || text || entryTools.length) {
        entries.push({ kind: 'assistant', id: entries.length, thinking, text, tools: entryTools });
      }
      continue;
    }
    let userText = '';
    for (const block of message.content) {
      if (block.type === 'text') userText += block.text;
      else if (block.type === 'tool_result') {
        const tool = tools.get(block.toolUseId);
        if (tool) tool.result = { content: block.content, ...(block.isError ? { isError: true } : {}) };
      }
    }
    if (userText) entries.push({ kind: 'user', id: entries.length, text: userText });
  }
  return entries;
}
