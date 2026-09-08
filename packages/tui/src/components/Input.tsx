/**
 * Input editor: a `@inkjs/ui` TextInput with `\`-continuation for multi-line
 * messages. A bare Enter submits; a trailing `\` appends to a pending buffer
 * and clears the line. History and a hand-rolled cursor editor are deferred.
 */

import { useState } from 'react';
import { Box, Text } from 'ink';
import { TextInput } from '@inkjs/ui';

import type { Theme } from '../theme.js';

export function Input({
  onSubmit,
  suggestions,
  theme,
  disabled,
}: {
  onSubmit: (text: string) => void;
  suggestions: string[];
  theme: Theme;
  disabled: boolean;
}) {
  const [resetKey, setResetKey] = useState(0);
  const [pending, setPending] = useState<string[]>([]);

  const handle = (value: string): void => {
    if (disabled) return;
    const trimmed = value.trimEnd();
    if (trimmed.endsWith('\\')) {
      setPending((p) => [...p, trimmed.slice(0, -1)]);
      setResetKey((k) => k + 1);
    } else if (trimmed !== '') {
      const full = [...pending, trimmed].join('\n');
      setPending([]);
      setResetKey((k) => k + 1);
      onSubmit(full);
    } else {
      setResetKey((k) => k + 1);
    }
  };

  return (
    <Box>
      {pending.length > 0 && <Text color={theme.faint}>{pending.length}⏎ </Text>}
      <Text color={theme.accent}>❯ </Text>
      <TextInput
        key={resetKey}
        placeholder="message the agent (Tab completes /commands)"
        suggestions={suggestions}
        isDisabled={disabled}
        onSubmit={handle}
      />
    </Box>
  );
}
