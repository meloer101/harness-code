import { useEffect, useRef } from 'react';

import type { SlashCommand } from '@/lib/slash';
import { cn } from '@/lib/utils';

const SOURCE_LABEL: Record<SlashCommand['source'], string> = {
  client: 'app',
  server: 'session',
  mcp: 'mcp',
};

/** The `/` completion list, anchored above the composer. */
export function SlashMenu({
  commands,
  active,
  onPick,
}: {
  commands: SlashCommand[];
  active: number;
  onPick: (command: SlashCommand) => void;
}) {
  const activeRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    // Guarded: jsdom (and old WebViews) have no scrollIntoView.
    activeRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);

  if (commands.length === 0) return null;

  return (
    <ul className="absolute bottom-full left-0 z-10 mb-2 max-h-64 w-full overflow-y-auto rounded-xl border bg-popover p-1 shadow-xl">
      {commands.map((c, i) => (
        <li
          key={`${c.source}:${c.name}`}
          ref={i === active ? activeRef : null}
          // Keep focus in the textarea: mousedown would blur it first.
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(c);
          }}
          className={cn(
            'flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-colors',
            i === active && 'bg-accent text-accent-foreground',
          )}
        >
          <span className="font-mono text-[13px] text-primary">/{c.name}</span>
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{c.hint}</span>
          <span className="shrink-0 rounded border bg-muted/60 px-1 font-mono text-[9px] tracking-wide text-muted-foreground uppercase">
            {SOURCE_LABEL[c.source]}
          </span>
        </li>
      ))}
    </ul>
  );
}
