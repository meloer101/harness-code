/**
 * Display components: the committed transcript and the status bars.
 * All pure presentation — they receive theme + state as props and render.
 */

import React from 'react';
import { Box, Text } from 'ink';

import { describeToolInput, fmtTokens, fmtUSD } from '@harness-code/core';
import type {
  ContextSnapshot,
  Notice,
  PermissionMode,
  ReasoningEffort,
  Usage,
} from '@harness-code/core';

import { Markdown } from '../markdown/render.js';
import type { Entry, ToolItem } from '../state/reducer.js';
import type { Theme } from '../theme.js';
import { truncate } from '../util/width.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';

export function Rule({ theme }: { theme: Theme }) {
  const { columns } = useTerminalSize();
  return <Text color={theme.faint}>{'─'.repeat(Math.min(columns, 100))}</Text>;
}

export function ModeBar({
  mode,
  modelRef,
  effort,
  cwd,
  theme,
}: {
  mode: PermissionMode;
  modelRef: string;
  effort?: ReasoningEffort;
  cwd: string;
  theme: Theme;
}) {
  const color =
    mode === 'plan'
      ? theme.accent
      : mode === 'acceptEdits'
        ? theme.warning
        : mode === 'yolo'
          ? theme.error
          : theme.dim;
  const base = cwd.split('/').filter(Boolean).at(-1) ?? cwd;
  return (
    <Text>
      <Text color={color}>● {mode}</Text>
      <Text color={theme.dim}>
        {'  '}
        {modelRef}
        {effort ? ` ${effort}` : ''} · {base}
      </Text>
    </Text>
  );
}

export function MeterBar({
  usage,
  context,
  theme,
}: {
  usage?: Usage;
  context?: ContextSnapshot;
  theme: Theme;
}) {
  if (!usage) return null;
  const cost = usage.costUSD !== undefined ? fmtUSD(usage.costUSD) : null;
  let ctx: string | null = null;
  let ctxColor = theme.dim;
  if (context) {
    const pct = Math.round(context.ratio * 100);
    const cells = 10;
    const filled = Math.max(0, Math.min(cells, Math.round(context.ratio * cells)));
    const bar = '█'.repeat(filled) + '░'.repeat(cells - filled);
    ctx = `ctx [${bar}] ${pct}% ${fmtTokens(context.usedTokens)}/${fmtTokens(context.windowTokens)}`;
    ctxColor = context.ratio >= 0.92 ? theme.error : context.ratio >= 0.8 ? theme.warning : theme.dim;
  }
  return (
    <Text color={theme.dim}>
      ↑{fmtTokens(usage.inputTokens)} ↓{fmtTokens(usage.outputTokens)}
      {cost ? ` ${cost}` : ''}
      {ctx ? (
        <Text color={ctxColor}> {ctx}</Text>
      ) : null}
    </Text>
  );
}

export function ToolCard({
  tool,
  expanded,
  theme,
}: {
  tool: ToolItem;
  expanded: boolean;
  theme: Theme;
}) {
  const { columns } = useTerminalSize();
  // Fit the summary to the terminal (minus the card's indent + "▸ name " prefix),
  // clamped so it never vanishes on a narrow window or sprawls on a wide one.
  const summaryWidth = Math.max(20, Math.min(columns - 8, 80));
  const summary = truncate(describeToolInput(tool.name, tool.input), summaryWidth, 'middle');
  const showOutput = (expanded || tool.result?.isError === true) && tool.result;
  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text color={tool.running ? theme.accent : theme.dim}>
        {tool.running ? '▸' : '▾'} {tool.name}
        {summary ? ` ${summary}` : ''}
      </Text>
      {showOutput && (
        <Box paddingLeft={2}>
          <Text color={tool.result!.isError ? theme.error : theme.dim}>
            {tool.result!.content.split('\n').map((l, i) => (
              <React.Fragment key={i}>
                {i > 0 ? '\n  │ ' : ''}
                {l}
              </React.Fragment>
            ))}
          </Text>
        </Box>
      )}
    </Box>
  );
}

export function NoticeLine({ notice, theme }: { notice: Notice; theme: Theme }) {
  const color =
    notice.level === 'error' ? theme.error : notice.level === 'warn' ? theme.warning : theme.dim;
  return <Text color={color}>{notice.text}</Text>;
}

export function HistoryEntry({
  entry,
  theme,
  expanded,
}: {
  entry: Entry;
  theme: Theme;
  expanded: boolean;
}) {
  switch (entry.kind) {
    case 'user':
      return (
        <Box marginTop={1}>
          <Text color={theme.accent}>❯ {entry.text}</Text>
        </Box>
      );
    case 'assistant':
      return (
        <Box marginTop={1}>
          <Text color={theme.text}>● </Text>
          <Box flexDirection="column" flexGrow={1}>
            {entry.thinking !== '' &&
              (expanded ? (
                <Text color={theme.faint}>{entry.thinking}</Text>
              ) : (
                <Text color={theme.faint}>· thinking</Text>
              ))}
            {entry.text !== '' && <Markdown text={entry.text} theme={theme} />}
            {entry.tools.map((t) => (
              <ToolCard key={t.id} tool={t} expanded={expanded} theme={theme} />
            ))}
          </Box>
        </Box>
      );
    case 'notice':
      return <NoticeLine notice={entry.notice} theme={theme} />;
  }
}
