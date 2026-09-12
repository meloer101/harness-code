import { Suspense, lazy, memo } from 'react';

import { cn } from '@/lib/utils';

const MarkdownBody = lazy(() =>
  import('@/components/MarkdownBody').then((m) => ({ default: m.MarkdownBody })),
);

/**
 * Assistant markdown (GFM). Loaded on demand so `react-markdown` stays out of the main bundle.
 */
export const Markdown = memo(function Markdown({
  text,
  streaming = false,
  className,
}: {
  text: string;
  streaming?: boolean;
  className?: string;
}) {
  return (
    <Suspense
      fallback={
        <div className={cn('md whitespace-pre-wrap text-sm', className)}>{text}</div>
      }
    >
      <MarkdownBody text={text} streaming={streaming} className={className} />
    </Suspense>
  );
});
