/**
 * Reasoning-effort picker overlay: a Faster↔Smarter scale the user scrubs with
 * ←/→. The app's central key handler drives `value`; this is pure display plus a
 * short highlight pulse on the selected level each time it changes.
 */

import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';

import type { ReasoningEffort } from '@harness-code/core';

import type { Theme } from '../theme.js';

const GAP = 3;

export function EffortPicker({
  value,
  levels,
  theme,
}: {
  value: ReasoningEffort;
  /** The model's accepted levels, Faster→Smarter. */
  levels: readonly ReasoningEffort[];
  theme: Theme;
}) {
  const [pulse, setPulse] = useState(false);
  useEffect(() => {
    setPulse(true);
    const t = setTimeout(() => setPulse(false), 160);
    return () => clearTimeout(t);
  }, [value]);

  const idx = Math.max(0, levels.indexOf(value));

  // Column geometry so the ▲ points at the centre of the selected label.
  const centers: number[] = [];
  let col = 0;
  levels.forEach((l, i) => {
    if (i > 0) col += GAP;
    centers.push(col + Math.floor(l.length / 2));
    col += l.length;
  });
  const width = col;
  const sel = centers[idx] ?? 0;
  const headline = 'Faster' + ' '.repeat(Math.max(1, width - 'Faster'.length - 'Smarter'.length)) + 'Smarter';

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text bold>Effort</Text>
      <Box marginTop={1} paddingLeft={2} flexDirection="column">
        <Text color={theme.dim}>{headline}</Text>
        <Text color={theme.dim}>{'─'.repeat(width)}</Text>
        <Text color={theme.accent}>{' '.repeat(sel) + '▲'}</Text>
        <Text>
          {levels.map((l, i) => (
            <React.Fragment key={l}>
              {i > 0 ? ' '.repeat(GAP) : ''}
              {i === idx ? (
                <Text color={theme.accent} bold inverse={pulse}>
                  {l}
                </Text>
              ) : (
                <Text color={theme.dim}>{l}</Text>
              )}
            </React.Fragment>
          ))}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.dim}>←/→ adjust · Enter confirm · Esc cancel</Text>
      </Box>
    </Box>
  );
}
