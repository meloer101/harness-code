/**
 * Per-tool rendering (opencode-style: a renderer per tool name, a generic
 * fallback for everything else — MCP tools included). Each renderer turns a
 * `ToolItem` into a header summary, optional header meta, and an expandable
 * body; `toolPreview` is the same idea for a call that hasn't run yet (the
 * permission dock), so an edit is reviewed as a diff, not a file path.
 */

import type { ReactNode } from 'react';
import { CheckCircle2, Circle, CircleDot } from 'lucide-react';

import { describeToolInput } from '@harness-code/core/browser';
import type { ToolItem } from '@harness-code/protocol';

import { CodeBlock } from '@/components/CodeBlock';
import { DiffStat, DiffView } from '@/components/DiffView';
import { Markdown } from '@/components/Markdown';
import { editDiff, writeDiff } from '@/lib/diff';
import { langForPath } from '@/lib/highlight';
import { cn } from '@/lib/utils';

export interface ToolView {
  /** Header text after the tool name. */
  summary: ReactNode;
  /** Right-aligned header extras (diff stat, counts). */
  meta?: ReactNode;
  /** Expanded content; null when there's nothing to expand. */
  body: ReactNode | null;
  defaultOpen: boolean;
}

type Rec = Record<string, unknown>;
const rec = (input: unknown): Rec => (input && typeof input === 'object' ? (input as Rec) : {});
const str = (r: Rec, k: string): string | undefined => (typeof r[k] === 'string' ? (r[k] as string) : undefined);
const num = (r: Rec, k: string): number | undefined => (typeof r[k] === 'number' ? (r[k] as number) : undefined);

/** Small diffs open by default; big ones stay folded. */
const OPEN_DIFF_LINES = 40;

function Output({ tool }: { tool: ToolItem }) {
  const content = tool.result?.content;
  if (!content) return null;
  return (
    <pre
      className={cn(
        'max-h-80 overflow-auto px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap',
        tool.result?.isError && 'text-red-600 dark:text-red-400',
      )}
    >
      {content}
    </pre>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono">{children}</span>;
}

/** Output only when it's an error — for tools whose body is something else. */
function ErrorOutput({ tool }: { tool: ToolItem }) {
  return tool.result?.isError ? (
    <div className="border-t">
      <Output tool={tool} />
    </div>
  ) : null;
}

type Renderer = (tool: ToolItem, input: Rec) => ToolView;

const renderers: Record<string, Renderer> = {
  bash: (tool, input) => ({
    summary: <Mono>{str(input, 'command') ?? ''}</Mono>,
    body: tool.result?.content ? <Output tool={tool} /> : null,
    defaultOpen: tool.result?.isError === true,
  }),

  edit: (tool, input) => {
    const diff = editDiff(str(input, 'oldString') ?? '', str(input, 'newString') ?? '');
    return {
      summary: <Mono>{str(input, 'path') ?? ''}</Mono>,
      meta: <DiffStat diff={diff} />,
      body: (
        <>
          <DiffView diff={diff} />
          <ErrorOutput tool={tool} />
        </>
      ),
      defaultOpen: tool.result?.isError === true || diff.lines.length <= OPEN_DIFF_LINES,
    };
  },

  write: (tool, input) => {
    const diff = writeDiff(str(input, 'content') ?? '');
    return {
      summary: <Mono>{str(input, 'path') ?? ''}</Mono>,
      meta: <DiffStat diff={diff} />,
      body: (
        <>
          <DiffView diff={diff} />
          <ErrorOutput tool={tool} />
        </>
      ),
      defaultOpen: tool.result?.isError === true || diff.lines.length <= OPEN_DIFF_LINES,
    };
  },

  read: (tool, input) => {
    const offset = num(input, 'offset');
    const limit = num(input, 'limit');
    const range = offset || limit ? `:${offset ?? 1}${limit ? `–${(offset ?? 1) + limit - 1}` : ''}` : '';
    return {
      summary: (
        <Mono>
          {str(input, 'path') ?? ''}
          {range}
        </Mono>
      ),
      body: tool.result?.content ? <Output tool={tool} /> : null,
      defaultOpen: tool.result?.isError === true,
    };
  },

  grep: (tool, input) => {
    const where = [str(input, 'path'), str(input, 'glob')].filter(Boolean).join(' ');
    return {
      summary: (
        <>
          <Mono>/{str(input, 'pattern') ?? ''}/</Mono>
          {where && <span className="text-muted-foreground/70"> in {where}</span>}
        </>
      ),
      body: tool.result?.content ? <Output tool={tool} /> : null,
      defaultOpen: tool.result?.isError === true,
    };
  },

  glob: (tool, input) => ({
    summary: <Mono>{str(input, 'pattern') ?? ''}</Mono>,
    body: tool.result?.content ? <Output tool={tool} /> : null,
    defaultOpen: tool.result?.isError === true,
  }),

  todo: (tool, input) => {
    const todos = Array.isArray(input['todos'])
      ? (input['todos'] as Array<{ id?: string; content?: string; status?: string }>)
      : [];
    const done = todos.filter((t) => t.status === 'completed').length;
    return {
      summary: `${done}/${todos.length} done`,
      body: (
        <ul className="space-y-1 px-3 py-2">
          {todos.map((t, i) => (
            <li key={t.id ?? i} className="flex items-start gap-2">
              {t.status === 'completed' ? (
                <CheckCircle2 className="mt-px size-3.5 shrink-0 text-emerald-500" />
              ) : t.status === 'in_progress' ? (
                <CircleDot className="mt-px size-3.5 shrink-0 text-sky-500" />
              ) : (
                <Circle className="mt-px size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className={cn(t.status === 'completed' && 'text-muted-foreground line-through')}>{t.content}</span>
            </li>
          ))}
          <ErrorOutput tool={tool} />
        </ul>
      ),
      defaultOpen: true,
    };
  },

  task: (tool, input) => ({
    summary: str(input, 'description') ?? str(input, 'subagent_type') ?? 'sub-agent',
    meta: str(input, 'subagent_type') ? (
      <span className="shrink-0 rounded bg-muted px-1.5 font-mono text-[10px] text-muted-foreground">
        {str(input, 'subagent_type')}
      </span>
    ) : undefined,
    body: (
      <div className="space-y-2 px-3 py-2">
        <p className="text-[11px] whitespace-pre-wrap text-muted-foreground">{str(input, 'prompt')}</p>
        {tool.result?.content &&
          (tool.result.isError ? <Output tool={tool} /> : <Markdown text={tool.result.content} className="text-xs" />)}
      </div>
    ),
    defaultOpen: false,
  }),

  exit_plan_mode: (tool, input) => ({
    summary: str(input, 'title') ?? 'Plan',
    body: (
      <div className="px-3 py-2">
        <Markdown text={str(input, 'plan') ?? ''} className="text-xs" />
        {tool.result?.content && (
          <p className="mt-2 border-t pt-2 text-[11px] text-muted-foreground">{tool.result.content}</p>
        )}
      </div>
    ),
    defaultOpen: false,
  }),
};

function genericView(tool: ToolItem): ToolView {
  return {
    summary: <Mono>{describeToolInput(tool.name, tool.input)}</Mono>,
    body: (
      <>
        <pre className="max-h-40 overflow-auto px-3 py-2 font-mono text-[11px] text-muted-foreground">
          {JSON.stringify(tool.input, null, 2)}
        </pre>
        {tool.result?.content && (
          <div className="border-t">
            <Output tool={tool} />
          </div>
        )}
      </>
    ),
    defaultOpen: tool.result?.isError === true,
  };
}

export function toolView(tool: ToolItem): ToolView {
  const render = renderers[tool.name];
  return render ? render(tool, rec(tool.input)) : genericView(tool);
}

/** What the permission dock shows for a call that hasn't run yet. */
export function toolPreview(toolName: string, input: unknown): ReactNode {
  const r = rec(input);
  switch (toolName) {
    case 'edit': {
      const diff = editDiff(str(r, 'oldString') ?? '', str(r, 'newString') ?? '');
      return (
        <div className="overflow-hidden rounded-md border bg-background">
          <div className="flex items-center gap-2 border-b px-3 py-1.5 font-mono text-xs">
            <span className="min-w-0 flex-1 truncate">{str(r, 'path')}</span>
            {r['replaceAll'] === true && <span className="text-[10px] text-muted-foreground">replace all</span>}
            <DiffStat diff={diff} />
          </div>
          <DiffView diff={diff} className="max-h-64" />
        </div>
      );
    }
    case 'write': {
      const path = str(r, 'path') ?? '';
      const content = str(r, 'content') ?? '';
      return (
        <div className="overflow-hidden rounded-md border bg-background">
          <div className="flex items-center gap-2 border-b px-3 py-1.5 font-mono text-xs">
            <span className="min-w-0 flex-1 truncate">{path}</span>
            <DiffStat diff={writeDiff(content)} />
          </div>
          <CodeBlock code={content} lang={langForPath(path) ?? undefined} className="my-0 max-h-64 overflow-auto rounded-none border-0" />
        </div>
      );
    }
    case 'bash':
      return <CodeBlock code={str(r, 'command') ?? ''} lang="bash" className="my-0" />;
    default: {
      const summary = describeToolInput(toolName, input);
      return summary ? (
        <pre className="max-h-40 overflow-auto rounded-md bg-muted/60 px-3 py-2 font-mono text-xs whitespace-pre-wrap">
          {summary}
        </pre>
      ) : null;
    }
  }
}
