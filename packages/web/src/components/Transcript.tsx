import { memo, useState } from 'react';
import { AlertTriangle, ArrowDown, Brain, Check, ChevronRight, Circle, Info, Loader2, X } from 'lucide-react';

import { describeToolInput } from '@harness-code/core/browser';
import type { Notice } from '@harness-code/core';
import type { Entry, LiveSnapshot, ToolItem } from '@harness-code/protocol';

import { Button } from '@/components/ui/button';
import { useStickToBottom } from '@/hooks/useStickToBottom';
import type { SessionViewState } from '@/lib/sessionModel';
import { cn } from '@/lib/utils';

export function Transcript({ view }: { view: SessionViewState }) {
  const { entries, live, running } = view;
  const { ref, onScroll, atBottom, scrollToBottom } = useStickToBottom<HTMLDivElement>(
    `${entries.length}:${live.text.length}:${live.thinking.length}:${live.tools.length}:${running}`,
  );
  const liveEmpty = live.text === '' && live.thinking === '' && live.tools.length === 0;

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={ref} onScroll={onScroll} className="h-full overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-6">
          {entries.length === 0 && liveEmpty && !running && (
            <p className="py-16 text-center text-sm text-muted-foreground">Send a message to start.</p>
          )}
          {entries.map((e) => (
            <EntryRow key={e.id} entry={e} />
          ))}
          {!liveEmpty && <AssistantBlock thinking={live.thinking} text={live.text} tools={live.tools} streaming />}
          {running && liveEmpty && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Working…
            </div>
          )}
        </div>
      </div>
      {!atBottom && (
        <Button
          size="sm"
          variant="secondary"
          className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-md"
          onClick={scrollToBottom}
        >
          <ArrowDown />
          Jump to bottom
        </Button>
      )}
    </div>
  );
}

/** Committed rows never change identity, so memo skips them while the live region streams. */
const EntryRow = memo(function EntryRow({ entry }: { entry: Entry }) {
  return (
    <div style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 80px' }}>
      {entry.kind === 'user' ? (
        <UserMessage text={entry.text} />
      ) : entry.kind === 'assistant' ? (
        <AssistantBlock thinking={entry.thinking} text={entry.text} tools={entry.tools} />
      ) : (
        <NoticeRow notice={entry.notice} />
      )}
    </div>
  );
});

function UserMessage({ text }: { text: string }) {
  return (
    <div className="rounded-lg border bg-muted/50 px-4 py-3 text-sm whitespace-pre-wrap">{text}</div>
  );
}

function AssistantBlock({
  thinking,
  text,
  tools,
  streaming = false,
}: LiveSnapshot & { streaming?: boolean }) {
  return (
    <div className="flex flex-col gap-2 text-sm">
      {thinking && <Thinking text={thinking} active={streaming && text === '' && tools.length === 0} />}
      {text && (
        <div className="leading-relaxed whitespace-pre-wrap">
          {text}
          {streaming && tools.length === 0 && <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-foreground/60 align-text-bottom" />}
        </div>
      )}
      {tools.map((t) => (
        <ToolCard key={t.id} tool={t} />
      ))}
    </div>
  );
}

function Thinking({ text, active }: { text: string; active: boolean }) {
  return (
    <details className="group text-muted-foreground">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs select-none">
        <ChevronRight className="size-3 transition-transform group-open:rotate-90" />
        <Brain className="size-3" />
        {active ? 'Thinking…' : 'Thinking'}
      </summary>
      <div className="mt-1.5 border-l-2 pl-3 text-xs leading-relaxed whitespace-pre-wrap">{text}</div>
    </details>
  );
}

function ToolCard({ tool }: { tool: ToolItem }) {
  const isError = tool.result?.isError === true;
  // Errors start expanded — including ones that arrive after the card mounted.
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? isError;
  const setOpen = (fn: (o: boolean) => boolean) => setToggled(fn(open));
  const summary = describeToolInput(tool.name, tool.input);
  const output = tool.result?.content ?? '';

  return (
    <div className={cn('rounded-md border text-xs', isError && 'border-red-500/40')}>
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        onClick={() => setOpen((o) => !o)}
        disabled={!output}
      >
        {tool.running ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : !tool.result ? (
          // Not run (yet): e.g. restored from a snapshot while its ask is pending.
          <Circle className="size-3.5 shrink-0 text-muted-foreground" />
        ) : isError ? (
          <X className="size-3.5 shrink-0 text-red-500" />
        ) : (
          <Check className="size-3.5 shrink-0 text-emerald-500" />
        )}
        <span className="font-medium">{tool.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">{summary}</span>
        {output && <ChevronRight className={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')} />}
      </button>
      {open && output && (
        <pre className="max-h-80 overflow-auto border-t bg-muted/40 px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
          {output}
        </pre>
      )}
    </div>
  );
}

function NoticeRow({ notice }: { notice: Notice }) {
  if (notice.kind === 'compaction') {
    return (
      <div className="flex items-center gap-3 py-1 text-[11px] text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        {notice.text}
        <span className="h-px flex-1 bg-border" />
      </div>
    );
  }
  const Icon = notice.level === 'info' ? Info : AlertTriangle;
  return (
    <div
      className={cn(
        'flex items-start gap-2 text-xs',
        notice.level === 'error' ? 'text-red-500' : notice.level === 'warn' ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground',
      )}
    >
      <Icon className="mt-px size-3.5 shrink-0" />
      <span className="whitespace-pre-wrap">{notice.text}</span>
    </div>
  );
}
