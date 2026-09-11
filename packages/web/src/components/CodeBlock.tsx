import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';

import { highlight } from '@/lib/highlight';
import { cn } from '@/lib/utils';

/**
 * A fenced code block: plain while streaming (re-highlighting every frame is
 * wasted work and flickers), Shiki once settled. Shiki escapes the code, so
 * its HTML is safe to inject.
 */
export function CodeBlock({
  code,
  lang,
  streaming = false,
  className,
}: {
  code: string;
  lang?: string | undefined;
  streaming?: boolean;
  className?: string;
}) {
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (streaming) return;
    let cancelled = false;
    void highlight(code, lang).then((h) => {
      if (!cancelled) setHtml(h);
    });
    return () => {
      cancelled = true;
    };
  }, [code, lang, streaming]);

  const copy = (): void => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <div className={cn('group/code relative my-2 overflow-hidden rounded-md border bg-muted/40', className)}>
      {lang && (
        <div className="border-b px-3 py-1 font-mono text-[10px] tracking-wide text-muted-foreground uppercase">
          {lang}
        </div>
      )}
      <button
        type="button"
        onClick={copy}
        className="absolute top-1 right-1 rounded p-1 text-muted-foreground opacity-0 transition-opacity group-hover/code:opacity-100 hover:bg-muted hover:text-foreground"
        aria-label="Copy code"
        title="Copy"
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
      {html && !streaming ? (
        <div className="shiki-wrap overflow-x-auto px-3 py-2 font-mono text-xs leading-relaxed" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="overflow-x-auto px-3 py-2 font-mono text-xs leading-relaxed">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}
