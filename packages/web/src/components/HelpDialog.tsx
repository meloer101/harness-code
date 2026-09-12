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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="max-h-[80vh] w-full max-w-lg overflow-y-auto rounded-xl border bg-popover p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Help"
      >
        <div className="mb-3 flex items-center">
          <h2 className="flex-1 text-sm font-semibold">Commands and shortcuts</h2>
          <button type="button" onClick={onClose} aria-label="Close">
            <X className="size-4 text-muted-foreground" />
          </button>
        </div>

        <h3 className="mt-4 mb-1 text-xs font-medium text-muted-foreground">Commands</h3>
        <ul className="space-y-1 text-sm">
          {commands.map((c) => (
            <li key={`${c.source}:${c.name}`} className="flex gap-3">
              <span className="w-32 shrink-0 font-mono text-xs">/{c.name}</span>
              <span className="text-muted-foreground">{c.hint}</span>
            </li>
          ))}
        </ul>

        <h3 className="mt-4 mb-1 text-xs font-medium text-muted-foreground">Keyboard</h3>
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
