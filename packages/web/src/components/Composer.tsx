import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { ArrowUp, Square } from 'lucide-react';

import { SlashMenu } from '@/components/SlashMenu';
import { Button } from '@/components/ui/button';
import { filterCommands, slashQuery } from '@/lib/slash';
import type { SlashCommand } from '@/lib/slash';
import { platform } from '@/platform';

const draftKey = (id: string) => `hc.draft.${id}`;

/**
 * Enter sends, Shift+Enter is a newline, and Enter while an IME is composing
 * (Chinese/Japanese input) only confirms the candidate. Typing `/` at the
 * start opens the command menu (↑/↓ to move, Enter or Tab to complete). While
 * a run is going the send button becomes Stop; the draft survives reloads per
 * session.
 */
export function Composer({
  sessionId,
  running,
  disabled,
  commands,
  onSend,
  onAbort,
}: {
  sessionId: string;
  running: boolean;
  disabled: boolean;
  commands: SlashCommand[];
  onSend: (text: string) => Promise<boolean>;
  onAbort: () => void;
}) {
  const [text, setText] = useState(() => platform.storage.get(draftKey(sessionId)) ?? '');
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  const query = slashQuery(text);
  const matches = useMemo(
    () => (query === null ? [] : filterCommands(commands, query)),
    [commands, query],
  );
  const menuOpen = !dismissed && matches.length > 0;

  // Mounted with `key={sessionId}`, so switching sessions remounts with that
  // session's draft instead of saving this one's text under the new id.
  useEffect(() => {
    ref.current?.focus();
  }, []);

  useEffect(() => {
    if (text) platform.storage.set(draftKey(sessionId), text);
    else platform.storage.remove(draftKey(sessionId));
  }, [sessionId, text]);

  // Grow with content up to a cap.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  useEffect(() => setActive(0), [query]);

  const canSend = !running && !disabled && text.trim() !== '';

  const submit = async (): Promise<void> => {
    if (!canSend) return;
    const value = text;
    setText('');
    if (!(await onSend(value))) setText(value);
  };

  const complete = (command: SlashCommand): void => {
    setText(`/${command.name} `);
    setDismissed(false);
    ref.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (menuOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing)) {
        e.preventDefault();
        const picked = matches[active];
        if (picked) complete(picked);
        return;
      }
      if (e.key === 'Escape') {
        // Don't let Escape reach the window handler and abort the run.
        e.preventDefault();
        e.stopPropagation();
        setDismissed(true);
        return;
      }
    }
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    void submit();
  };

  return (
    <div className="relative">
      {menuOpen && <SlashMenu commands={matches} active={active} onPick={complete} />}
      <div className="flex items-end gap-2 rounded-xl border bg-card p-2 shadow-sm transition-shadow focus-within:border-primary/45 focus-within:shadow-md focus-within:ring-2 focus-within:ring-primary/25">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setDismissed(false);
          }}
          onKeyDown={onKeyDown}
          placeholder={running ? 'Running… you can type the next message' : 'Message hc — Enter to send, / for commands'}
          className="max-h-60 min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground"
          disabled={disabled}
        />
        {running ? (
          <Button size="icon" variant="secondary" onClick={onAbort} aria-label="Stop" title="Stop (Esc)">
            <Square className="fill-current" />
          </Button>
        ) : (
          <Button size="icon" onClick={() => void submit()} disabled={!canSend} aria-label="Send" title="Send">
            <ArrowUp />
          </Button>
        )}
      </div>
    </div>
  );
}
