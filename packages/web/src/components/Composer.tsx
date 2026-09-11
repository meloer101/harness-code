import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { ArrowUp, Square } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { platform } from '@/platform';

const draftKey = (id: string) => `hc.draft.${id}`;

/**
 * Enter sends, Shift+Enter is a newline, and Enter while an IME is composing
 * (Chinese/Japanese input) only confirms the candidate. While a run is going
 * the send button becomes Stop; the draft survives reloads per session.
 */
export function Composer({
  sessionId,
  running,
  disabled,
  onSend,
  onAbort,
}: {
  sessionId: string;
  running: boolean;
  disabled: boolean;
  onSend: (text: string) => Promise<boolean>;
  onAbort: () => void;
}) {
  const [text, setText] = useState(() => platform.storage.get(draftKey(sessionId)) ?? '');
  const ref = useRef<HTMLTextAreaElement>(null);

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

  const canSend = !running && !disabled && text.trim() !== '';

  const submit = async (): Promise<void> => {
    if (!canSend) return;
    const value = text;
    setText('');
    if (!(await onSend(value))) setText(value);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    void submit();
  };

  return (
    <div className="flex items-end gap-2 rounded-xl border bg-background p-2 shadow-sm focus-within:ring-2 focus-within:ring-ring/40">
      <textarea
        ref={ref}
        rows={1}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={running ? 'Running… you can type the next message' : 'Message hc — Enter to send, Shift+Enter for a newline'}
        className="max-h-60 min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground"
        disabled={disabled}
      />
      {running ? (
        <Button size="icon" variant="secondary" onClick={onAbort} aria-label="Stop" title="Stop">
          <Square className="fill-current" />
        </Button>
      ) : (
        <Button size="icon" onClick={() => void submit()} disabled={!canSend} aria-label="Send" title="Send">
          <ArrowUp />
        </Button>
      )}
    </div>
  );
}
