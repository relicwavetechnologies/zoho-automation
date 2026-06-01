import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { highlightCode } from '@/lib/markdown/highlighter';
import { cn } from '@/lib/utils';

interface CodeBlockProps {
  code: string;
  lang?: string;
}

export function CodeBlock({ code, lang }: CodeBlockProps) {
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    highlightCode(code, lang).then((out) => {
      if (!cancelled) setHtml(out);
    });
    return () => { cancelled = true; };
  }, [code, lang]);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="my-3 overflow-hidden rounded-md border border-border-subtle bg-[hsl(0_0%_5%)] text-[12.5px]">
      <div className="flex items-center justify-between border-b border-border-subtle bg-surface-1 px-3 py-1.5">
        <span className="font-mono text-[10.5px] uppercase tracking-wider text-fg-dim">
          {lang || 'text'}
        </span>
        <button
          onClick={onCopy}
          className={cn(
            'inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[10.5px] text-fg-muted transition-colors',
            'hover:bg-surface-2 hover:text-foreground',
          )}
        >
          {copied ? (
            <>
              <Check className="h-3 w-3 text-success" />
              Copied
            </>
          ) : (
            <>
              <Copy className="h-3 w-3" />
              Copy
            </>
          )}
        </button>
      </div>
      <div className="overflow-x-auto px-3.5 py-3 font-mono text-[12.5px] leading-[1.65]">
        {html ? (
          <div dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <pre className="whitespace-pre text-fg-muted">{code}</pre>
        )}
      </div>
    </div>
  );
}
