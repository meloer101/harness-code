import { useEffect, useState } from 'react';
import { useStdout } from 'ink';

/**
 * Terminal width, live-updating on `stdout` resize. Committed `<Static>` lines
 * don't reflow on resize (they stay in native scrollback — acceptable, matching
 * a normal terminal); the bars and live region do.
 */
export function useTerminalSize(): { columns: number } {
  const { stdout } = useStdout();
  const [columns, setColumns] = useState<number>(() => stdout?.columns ?? 80);

  useEffect(() => {
    if (!stdout) return;
    const onResize = (): void => setColumns(stdout.columns ?? 80);
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  return { columns };
}
