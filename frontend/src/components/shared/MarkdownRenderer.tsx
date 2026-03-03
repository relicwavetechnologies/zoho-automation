"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import "highlight.js/styles/github-dark.css";

import { Button } from "@/components/ui/button";

function CodeBlock({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLElement> & { inline?: boolean }) {
  const [copied, setCopied] = useState(false);
  const match = /language-([\w-]+)/.exec(className || "");
  const language = match?.[1] || "text";
  const code = String(children || "").replace(/\n$/, "");

  if (!className?.includes("language-")) {
    return (
      <code
        className="rounded px-1.5 py-0.5"
        style={{ backgroundColor: "var(--bg-elevated)", color: "var(--accent)" }}
        {...props}
      >
        {children}
      </code>
    );
  }

  return (
    <div className="mb-3 overflow-hidden rounded-lg border" style={{ borderColor: "var(--border-subtle)" }}>
      <div
        className="flex items-center justify-between border-b px-3 py-2 text-xs"
        style={{ backgroundColor: "var(--bg-surface)", borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}
      >
        <span>{language}</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={async () => {
            await navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
      </div>
      <pre className="overflow-x-auto p-3 text-sm" style={{ backgroundColor: "#0d0d0d" }}>
        <code className={className} {...props}>
          {code}
        </code>
      </pre>
    </div>
  );
}

interface MarkdownRendererProps {
  content: string;
}

export default function MarkdownRenderer({ content }: MarkdownRendererProps) {
  return (
    <div className="max-w-none break-words text-[15px] leading-relaxed text-primary">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          code: ({ className, children, ...props }) => (
            <CodeBlock className={className} {...props}>
              {children}
            </CodeBlock>
          ),
          a: ({ ...props }) => (
            <a
              {...props}
              target="_blank"
              rel="noreferrer"
              className="underline decoration-transparent hover:decoration-current"
              style={{ color: "var(--accent)" }}
            />
          ),
          table: ({ ...props }) => (
            <div className="mb-3 overflow-x-auto">
              <table
                {...props}
                className="w-full border-collapse text-sm"
                style={{ borderColor: "var(--border-subtle)" }}
              />
            </div>
          ),
          th: ({ ...props }) => (
            <th
              {...props}
              className="border px-2 py-1 text-left"
              style={{ borderColor: "var(--border-subtle)", backgroundColor: "var(--bg-surface)" }}
            />
          ),
          td: ({ ...props }) => (
            <td {...props} className="border px-2 py-1" style={{ borderColor: "var(--border-subtle)" }} />
          ),
          blockquote: ({ ...props }) => (
            <blockquote
              {...props}
              className="mb-3 border-l-4 px-3 py-2 italic"
              style={{ borderColor: "var(--accent)", backgroundColor: "var(--bg-surface)" }}
            />
          ),
          h1: ({ ...props }) => (
            <h1 {...props} className="mb-2 mt-4 border-b pb-1 text-2xl" style={{ borderColor: "var(--border-subtle)" }} />
          ),
          h2: ({ ...props }) => (
            <h2 {...props} className="mb-2 mt-4 border-b pb-1 text-xl" style={{ borderColor: "var(--border-subtle)" }} />
          ),
          h3: ({ ...props }) => <h3 {...props} className="mb-2 mt-4 text-lg" />,
          ul: ({ ...props }) => <ul {...props} className="mb-3 list-disc pl-6 marker:text-accent" />,
          ol: ({ ...props }) => <ol {...props} className="mb-3 list-decimal pl-6 marker:text-accent" />,
          p: ({ ...props }) => <p {...props} className="mb-3 last:mb-0" />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
