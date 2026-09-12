import type { ReactNode } from 'react';

import type { ToolItem } from '@harness-code/protocol';

import { CodeBlock } from '@/components/CodeBlock';
import { DiffStat, DiffView } from '@/components/DiffView';
import { editDiff, writeDiff } from '@/lib/diff';
import { langForPath } from '@/lib/highlight';

function ErrorOutput({ tool }: { tool: ToolItem }) {
  const content = tool.result?.content;
  if (!content || !tool.result?.isError) return null;
  return (
    <pre className="max-h-80 overflow-auto border-t px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-destructive">
      {content}
    </pre>
  );
}

export function EditDiffPanel({
  tool,
  oldString,
  newString,
}: {
  tool: ToolItem;
  oldString: string;
  newString: string;
}) {
  const diff = editDiff(oldString, newString);
  return (
    <>
      <DiffView diff={diff} />
      <ErrorOutput tool={tool} />
    </>
  );
}

export function EditDiffMeta({ oldString, newString }: { oldString: string; newString: string }) {
  return <DiffStat diff={editDiff(oldString, newString)} />;
}

export function WriteDiffPanel({ tool, content }: { tool: ToolItem; content: string }) {
  const diff = writeDiff(content);
  return (
    <>
      <DiffView diff={diff} />
      <ErrorOutput tool={tool} />
    </>
  );
}

export function WriteDiffMeta({ content }: { content: string }) {
  return <DiffStat diff={writeDiff(content)} />;
}

export function EditPreviewPanel({
  path,
  oldString,
  newString,
  replaceAll,
}: {
  path: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}) {
  const diff = editDiff(oldString, newString);
  return (
    <div className="overflow-hidden rounded-md border bg-background">
      <div className="flex items-center gap-2 border-b px-3 py-1.5 font-mono text-xs">
        <span className="min-w-0 flex-1 truncate">{path}</span>
        {replaceAll === true && <span className="text-[10px] text-muted-foreground">replace all</span>}
        <DiffStat diff={diff} />
      </div>
      <DiffView diff={diff} className="max-h-64" />
    </div>
  );
}

export function WritePreviewPanel({ path, content }: { path: string; content: string }) {
  return (
    <div className="overflow-hidden rounded-md border bg-background">
      <div className="flex items-center gap-2 border-b px-3 py-1.5 font-mono text-xs">
        <span className="min-w-0 flex-1 truncate">{path}</span>
        <DiffStat diff={writeDiff(content)} />
      </div>
      <CodeBlock
        code={content}
        lang={langForPath(path) ?? undefined}
        className="my-0 max-h-64 overflow-auto rounded-none border-0"
      />
    </div>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono">{children}</span>;
}
