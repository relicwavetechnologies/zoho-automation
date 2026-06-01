import { memo, useMemo } from 'react';
import { marked } from 'marked';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CodeBlock } from './CodeBlock';
import { openExternal } from '@/lib/tauri';
import { cn } from '@/lib/utils';

interface MarkdownProps {
  content: string;
  streaming?: boolean;
}

/**
 * Chat-flavoured markdown renderer: GFM tables, task lists, Shiki code blocks,
 * external link handling, streaming-safe (auto-closes dangling code fences).
 *
 * Performance: streaming a reply token-by-token would otherwise re-parse the
 * entire markdown document on every token — O(n²) and the dominant cause of
 * "the model is fast but the text crawls". We split the document into top-level
 * blocks (via `marked`'s lexer) and memoize each block by its raw string, so
 * only the final, still-growing block re-parses per token. Completed blocks are
 * cached and skipped. This is the Vercel AI SDK / Streamdown approach.
 */
export function Markdown({ content, streaming = false }: MarkdownProps) {
  const blocks = useMemo(() => {
    const safe = sanitizeStreaming(stripProtocolEnvelope(content), streaming);
    return parseMarkdownIntoBlocks(safe);
  }, [content, streaming]);

  return (
    <div className="divo-md text-[14px] leading-[1.72] text-foreground [&>*:first-child]:!mt-0 [&>*:last-child]:!mb-0">
      {blocks.map((block, i) => (
        <MemoizedMarkdownBlock key={i} content={block} />
      ))}
      {streaming ? (
        <span className="ml-0.5 inline-block h-3.5 w-[2px] translate-y-[2px] animate-pulse bg-fg-muted" />
      ) : null}
    </div>
  );
}

/**
 * Split markdown into discrete top-level blocks. `marked` keeps multi-line
 * constructs (lists, tables, fenced code) intact as single tokens, so each
 * block renders losslessly on its own. `token.raw` reconstructs the exact
 * source, so concatenating the blocks equals the original document.
 */
function parseMarkdownIntoBlocks(markdown: string): string[] {
  if (!markdown) return [];
  return marked.lexer(markdown).map((token) => token.raw);
}

/**
 * One markdown block, parsed + rendered in isolation and memoized on its raw
 * string. During streaming, every block but the last has a frozen string, so
 * this short-circuits and React skips re-parsing them entirely.
 */
const MemoizedMarkdownBlock = memo(
  function MemoizedMarkdownBlock({ content }: { content: string }) {
    return (
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {content}
      </ReactMarkdown>
    );
  },
  (prev, next) => prev.content === next.content,
);

/**
 * Divo's supervisor wraps its output in an `[Execution]` / `[Reply]` envelope.
 * The activity stream already shows tool calls, so the `[Execution]` block is
 * duplicate noise — keep only the reply body for the markdown render.
 *
 * Tolerant to streaming: if `[Reply]` hasn't arrived yet, returns empty (the
 * activity stream is doing the talking). Bare prose without the envelope passes
 * through untouched.
 */
function stripProtocolEnvelope(content: string): string {
  if (!content) return content;
  const replyMatch = content.match(/\[Reply\][:\s]*/i);
  if (replyMatch && typeof replyMatch.index === 'number') {
    return content.slice(replyMatch.index + replyMatch[0].length).trimStart();
  }
  // Mid-stream: we've seen [Execution] but [Reply] hasn't landed. Render nothing
  // (the activity stream is informative enough; raw tool dumps would be ugly).
  if (/\[Execution\]/i.test(content)) {
    return '';
  }
  return content;
}

/** If an odd number of ``` fences exist (i.e. open without close), append a synthetic
 *  closing fence so the live-rendered preview is still highlighted instead of dumping
 *  raw code into the surrounding paragraph. */
function sanitizeStreaming(content: string, streaming: boolean): string {
  if (!streaming) return content;
  const fences = content.match(/```/g);
  if (fences && fences.length % 2 === 1) {
    return `${content}\n\`\`\``;
  }
  return content;
}

const COMPONENTS: Components = {
  p: ({ node: _n, ...p }) => <p className="my-2.5" {...p} />,

  strong: ({ node: _n, ...p }) => <strong className="font-semibold text-foreground" {...p} />,
  em: ({ node: _n, ...p }) => <em className="italic" {...p} />,

  ul: ({ node: _n, ...p }) => (
    <ul className="my-2.5 ml-5 list-disc space-y-1 marker:text-fg-faint" {...p} />
  ),
  ol: ({ node: _n, ...p }) => (
    <ol className="my-2.5 ml-5 list-decimal space-y-1 marker:text-fg-muted" {...p} />
  ),
  li: ({ node: _n, children, ...p }) => (
    <li className="pl-1 [&>p]:my-0 [&>ul]:mt-1 [&>ol]:mt-1" {...p}>
      {children}
    </li>
  ),

  h1: ({ node: _n, ...p }) => (
    <h1 className="mb-3 mt-6 text-[20px] font-semibold leading-tight tracking-tight" {...p} />
  ),
  h2: ({ node: _n, ...p }) => (
    <h2 className="mb-2.5 mt-5 text-[16.5px] font-semibold leading-snug tracking-tight" {...p} />
  ),
  h3: ({ node: _n, ...p }) => (
    <h3 className="mb-2 mt-4 text-[14.5px] font-semibold leading-snug" {...p} />
  ),
  h4: ({ node: _n, ...p }) => (
    <h4 className="mb-1.5 mt-3 text-[13.5px] font-semibold leading-snug text-fg-muted" {...p} />
  ),

  hr: () => <hr className="my-5 border-0 border-t border-border-subtle" />,

  blockquote: ({ node: _n, ...p }) => (
    <blockquote
      className="my-3 border-l-2 border-border-strong pl-3.5 italic text-fg-muted"
      {...p}
    />
  ),

  a: ({ node: _n, href, children, ...p }) => (
    <a
      href={href ?? '#'}
      onClick={(e) => {
        if (!href) return;
        e.preventDefault();
        void openExternal(href);
      }}
      className="text-foreground underline decoration-fg-faint underline-offset-2 transition-colors hover:decoration-foreground"
      {...p}
    >
      {children}
    </a>
  ),

  code: ({ node: _n, className, children, ...rest }) => {
    const match = /language-(\w+)/.exec(className ?? '');
    const isBlock = typeof match !== 'undefined' && match !== null;
    const text = String(children ?? '').replace(/\n$/, '');
    if (isBlock) {
      return <CodeBlock code={text} lang={match[1]} />;
    }
    return (
      <code
        className="rounded-[5px] bg-[hsl(28_50%_15%/0.55)] px-[5px] py-[1.5px] font-mono text-[12.5px] text-[hsl(28_90%_72%)]"
        {...rest}
      >
        {children}
      </code>
    );
  },
  // react-markdown wraps `code` in `pre` for fenced blocks; we render the block
  // through CodeBlock inside `code` and want to drop the surrounding `pre`.
  pre: ({ node: _n, children }) => <>{children}</>,

  table: ({ node: _n, children }) => (
    <div className="my-4 overflow-x-auto rounded-md border border-border-subtle">
      <table className="w-full border-collapse text-[13px]">{children}</table>
    </div>
  ),
  thead: ({ node: _n, ...p }) => <thead {...p} />,
  th: ({ node: _n, ...p }) => (
    <th
      className="border-b border-border-subtle px-3 py-2.5 text-left text-[13px] font-semibold text-foreground"
      {...p}
    />
  ),
  td: ({ node: _n, className, ...p }) => (
    <td
      className={cn(
        'border-b border-border-subtle/70 px-3 py-2 align-top text-[13px] text-foreground last:border-b-0',
        className,
      )}
      {...p}
    />
  ),
  tr: ({ node: _n, ...p }) => <tr {...p} />,

  // GFM task list items
  input: ({ node: _n, type, checked, ...p }) => {
    if (type === 'checkbox') {
      return (
        <span
          className={cn(
            'mr-1.5 inline-flex h-[14px] w-[14px] translate-y-[2px] items-center justify-center rounded-sm border',
            checked
              ? 'border-success bg-success text-background'
              : 'border-border-strong bg-transparent',
          )}
          aria-checked={!!checked}
          role="checkbox"
        >
          {checked ? '✓' : ''}
        </span>
      );
    }
    return <input type={type} {...p} />;
  },

  img: ({ node: _n, src, alt }) => (
    <img
      src={src ?? ''}
      alt={alt ?? ''}
      className="my-3 max-h-[420px] rounded-md border border-border-subtle"
    />
  ),
};
