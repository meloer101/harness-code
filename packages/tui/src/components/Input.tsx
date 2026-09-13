/**
 * Input editor: a `@inkjs/ui` TextInput with `\`-continuation for multi-line
 * messages. A bare Enter submits; a trailing `\` appends to a pending buffer
 * and clears the line.
 *
 * While the line is a bare `/command` prefix, a reference menu pops up *above*
 * the box listing matching commands and their descriptions. It's display-only:
 * Tab still completes the top match via the TextInput's own suggestions, and
 * the first (highlighted) row is what Tab will fill in.
 */

import { useState } from 'react';
import { Box, Text } from 'ink';
import { TextInput } from '@inkjs/ui';

import type { Theme } from '../theme.js';

export interface CommandInfo {
  command: string;
  description: string;
}

const MENU_MAX = 8;

export function Input({
  onSubmit,
  commands,
  theme,
  disabled,
}: {
  onSubmit: (text: string) => void;
  commands: CommandInfo[];
  theme: Theme;
  disabled: boolean;
}) {
  const [resetKey, setResetKey] = useState(0);
  const [pending, setPending] = useState<string[]>([]);
  const [value, setValue] = useState('');

  const handle = (submitted: string): void => {
    if (disabled) return;
    const trimmed = submitted.trimEnd();
    if (trimmed.endsWith('\\')) {
      setPending((p) => [...p, trimmed.slice(0, -1)]);
    } else if (trimmed !== '') {
      const full = [...pending, trimmed].join('\n');
      setPending([]);
      onSubmit(full);
    }
    setValue('');
    setResetKey((k) => k + 1);
  };

  // The command menu shows while the line is a bare `/name` (no space yet).
  const matches =
    !disabled && /^\/\S*$/.test(value)
      ? commands.filter((c) => c.command.toLowerCase().startsWith(value.toLowerCase())).slice(0, MENU_MAX)
      : [];

  return (
    <Box flexDirection="column">
      {matches.length > 0 && (
        <Box flexDirection="column" paddingLeft={2}>
          {matches.map((c, i) => (
            <Text key={c.command}>
              <Text color={theme.accent} bold={i === 0}>
                {c.command.padEnd(12)}
              </Text>
              <Text color={theme.dim}>{c.description}</Text>
            </Text>
          ))}
        </Box>
      )}
      <Box borderStyle="round" borderColor={disabled ? theme.faint : theme.accent} paddingX={1}>
        {pending.length > 0 && <Text color={theme.faint}>{pending.length}⏎ </Text>}
        <Text color={theme.accent}>❯ </Text>
        <TextInput
          key={resetKey}
          placeholder="message the agent (Tab completes /commands)"
          suggestions={commands.map((c) => c.command)}
          isDisabled={disabled}
          onChange={setValue}
          onSubmit={handle}
        />
      </Box>
    </Box>
  );
}
