import { useEffect } from 'react';
import { X } from 'lucide-react';

import type { SlashCommand } from '@/lib/slash';

const SHORTCUTS: Array<[string, string]> = [
  ['Enter', 'Send message'],
  ['Shift+Enter', 'New line'],
  ['/', 'Command menu'],
  ['⌘K / Ctrl+K', 'New session'],
  ['Esc', 'Stop the current run'],
  ['y / a / n', 'Permission prompt: allow once / always / deny'],
  ['y / n', 'Plan prompt: approve / reject'],
];

/** `/help`: the commands and keys, as a dismissible panel. */
export function HelpDialog({ commands, onClose }: { commands: SlashCommand[]; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/25 p-6 backdrop-blur-[2px]"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="max-h-[80vh] w-full max-w-lg overflow-y-auto rounded-xl border bg-popover p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Help"
      >
        <div className="mb-3 flex items-center">
          <h2 className="flex-1 font-serif text-base font-semibold tracking-[-0.01em]">Commands and shortcuts</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 transition-colors hover:bg-accent"
          >
            <X className="size-4 text-muted-foreground" />
          </button>
        </div>

        <h3 className="mt-4 mb-1 font-mono text-[10px] font-medium tracking-[0.14em] text-muted-foreground uppercase">
          Commands
        </h3>
        <ul className="space-y-1 text-sm">
          {commands.map((c) => (
            <li key={`${c.source}:${c.name}`} className="flex gap-3">
              <span className="w-32 shrink-0 font-mono text-xs text-primary">/{c.name}</span>
              <span className="text-muted-foreground">{c.hint}</span>
            </li>
          ))}
        </ul>

        <h3 className="mt-4 mb-1 font-mono text-[10px] font-medium tracking-[0.14em] text-muted-foreground uppercase">
          Keyboard
        </h3>
        <ul className="space-y-1 text-sm">
          {SHORTCUTS.map(([keys, what]) => (
            <li key={keys} className="flex gap-3">
              <span className="w-32 shrink-0 font-mono text-xs">{keys}</span>
              <span className="text-muted-foreground">{what}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
