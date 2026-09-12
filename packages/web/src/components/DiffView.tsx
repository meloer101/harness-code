import type { LineDiff } from '@/lib/diff';
import { cn } from '@/lib/utils';

/** Lines beyond this are summarised — a 2,000-line `write` shouldn't render in full. */
const MAX_LINES = 400;

export function DiffView({ diff, className }: { diff: LineDiff; className?: string }) {
  const shown = diff.lines.slice(0, MAX_LINES);
  const hidden = diff.lines.length - shown.length;
  return (
    <div className={cn('max-h-96 overflow-auto font-mono text-[11px] leading-relaxed', className)}>
      <table className="w-full border-collapse">
        <tbody>
          {shown.map((line, i) => (
            <tr
              key={i}
              className={cn(
                line.kind === 'add' && 'bg-success/10 text-success',
                line.kind === 'del' && 'bg-destructive/10 text-destructive',
              )}
            >
              <td className="w-5 px-2 text-center align-top text-muted-foreground select-none">
                {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}
              </td>
              <td className="pr-3 whitespace-pre-wrap break-all">{line.text || ' '}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {hidden > 0 && (
        <div className="px-3 py-1 text-muted-foreground">… {hidden.toLocaleString()} more lines</div>
      )}
    </div>
  );
}

export function DiffStat({ diff }: { diff: LineDiff }) {
  return (
    <span className="shrink-0 font-mono text-[11px]">
      {diff.added > 0 && <span className="text-success">+{diff.added}</span>}
      {diff.added > 0 && diff.removed > 0 && ' '}
      {diff.removed > 0 && <span className="text-destructive">−{diff.removed}</span>}
    </span>
  );
}
