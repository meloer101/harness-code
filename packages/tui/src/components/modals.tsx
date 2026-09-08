/**
 * Modal overlays: permission approval, plan approval, and the `/help`-style
 * overlay. Pure display — the app's central key handler routes `y`/`a`/`n`/
 * `Esc` to the bridge resolvers, so these never install their own `useInput`.
 */

import React from 'react';
import { Box, Text } from 'ink';

import { describeToolInput } from '@harness-code/core';

import { Markdown } from '../markdown/render.js';
import type { PendingAsk, PendingPlan } from '../state/reducer.js';
import type { Theme } from '../theme.js';

export function PermissionModal({
  ask,
  theme,
}: {
  ask: PendingAsk;
  theme: Theme;
}) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text bold>{ask.reason}</Text>
      <Text color={theme.dim}>{describeToolInput(ask.toolName, ask.input)}</Text>
      <Text color={theme.dim}>[y] allow once  [a] always allow  [n/Esc] deny</Text>
    </Box>
  );
}

export function PlanModal({
  plan,
  theme,
}: {
  plan: PendingPlan;
  theme: Theme;
}) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text bold>{plan.title}</Text>
      <Markdown text={plan.body} theme={theme} />
      <Text color={theme.dim}>[y] approve  [e] revise  [Esc] keep planning</Text>
    </Box>
  );
}

export function Overlay({
  kind,
  theme,
  sessions,
  onPick,
}: {
  kind: 'help' | 'resume';
  theme: Theme;
  sessions?: { id: string; mtimeMs: number }[];
  onPick?: (id: string) => void;
}) {
  if (kind === 'help') {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
        <Text bold>keys</Text>
        <Text color={theme.dim}>Esc — abort turn / close · Ctrl+C ×2 — quit · Ctrl+D — quit (empty) · Ctrl+O — expand output</Text>
        <Text bold>commands</Text>
        <Text color={theme.dim}>
          /help /clear /quit /compact /cost /resume /plan · Tab — complete · MCP prompts via /name
        </Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text bold>resume session</Text>
      {(sessions ?? []).slice(0, 10).map((s, i) => (
        <Text key={s.id}>
          <Text color={theme.accent}>{i + 1}.</Text> {s.id}
          {onPick ? (
            <Text color={theme.dim}>  (press {i + 1} to open)</Text>
          ) : null}
        </Text>
      ))}
      {sessions && sessions.length === 0 && <Text color={theme.dim}>(no sessions)</Text>}
    </Box>
  );
}
