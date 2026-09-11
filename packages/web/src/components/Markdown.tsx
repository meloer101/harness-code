import { isValidElement, memo } from 'react';
import type { ReactElement, ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { CodeBlock } from '@/components/CodeBlock';
import { closeOpenFences } from '@/lib/markdown';
import { cn } from '@/lib/utils';
import { platform } from '@/platform';

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return '';
}

function makeComponents(streaming: boolean): Components {
  return {
    // Fenced blocks arrive as <pre><code class="language-x">; render them as
    // one CodeBlock. Inline `code` keeps the default element (styled in CSS).
    pre({ children }) {
      const child = Array.isArray(children) ? children[0] : children;
      const props = isValidElement(child) ? (child as ReactElement<{ className?: string; children?: ReactNode }>).props : {};
      const lang = /language-([\w+-]+)/.exec(props.className ?? '')?.[1];
      const code = textOf(props.children).replace(/\n$/, '');
      return <CodeBlock code={code} lang={lang} streaming={streaming} />;
    },
    a({ href, children }) {
      return (
        <a
          href={href}
          onClick={(e) => {
            if (!href) return;
            e.preventDefault();
            platform.openExternal(href);
          }}
        >
          {children}
        </a>
      );
    },
    table({ children }) {
      return (
        <div className="my-2 overflow-x-auto">
          <table>{children}</table>
        </div>
      );
    },
  };
}

const settledComponents = makeComponents(false);
const streamingComponents = makeComponents(true);

/**
 * Assistant markdown (GFM). While streaming, a dangling code fence is closed
 * so the layout doesn't flip every frame, and code blocks skip highlighting.
 * Raw HTML in the source is not rendered (react-markdown's default).
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
    <div className={cn('md', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={streaming ? streamingComponents : settledComponents}>
        {streaming ? closeOpenFences(text) : text}
      </ReactMarkdown>
    </div>
  );
});
