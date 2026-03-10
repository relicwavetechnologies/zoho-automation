import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface Props {
  content: string
  className?: string
}

export function MarkdownContent({ content, className }: Props): JSX.Element {
  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ...props }) => (
            <a
              {...props}
              target="_blank"
              rel="noreferrer"
              className="text-[hsl(210,85%,70%)] underline underline-offset-4 hover:text-[hsl(210,85%,78%)]"
            />
          ),
          p: ({ node: _node, ...props }) => <p {...props} className="mb-3 last:mb-0" />,
          ul: ({ node: _node, ...props }) => <ul {...props} className="mb-3 list-disc pl-5 last:mb-0" />,
          ol: ({ node: _node, ...props }) => <ol {...props} className="mb-3 list-decimal pl-5 last:mb-0" />,
          li: ({ node: _node, ...props }) => <li {...props} className="mb-1 last:mb-0" />,
          blockquote: ({ node: _node, ...props }) => (
            <blockquote
              {...props}
              className="my-3 border-l-2 border-[hsl(0,0%,20%)] pl-4 text-[hsl(0,0%,64%)]"
            />
          ),
          code: ({ node: _node, className: codeClassName, children, ...props }) => {
            const inline = !codeClassName
            if (inline) {
              return (
                <code
                  {...props}
                  className="rounded bg-[hsl(0,0%,10%)] px-1.5 py-0.5 text-[0.82rem] text-[hsl(0,0%,86%)]"
                >
                  {children}
                </code>
              )
            }

            return (
              <code {...props} className={codeClassName}>
                {children}
              </code>
            )
          },
          pre: ({ node: _node, ...props }) => (
            <pre
              {...props}
              className="my-3 overflow-x-auto rounded-xl border border-[hsl(0,0%,16%)] bg-[hsl(0,0%,8%)] p-3 text-[hsl(0,0%,82%)]"
            />
          ),
          table: ({ node: _node, ...props }) => (
            <div className="my-3 overflow-x-auto">
              <table {...props} className="w-full border-collapse text-left text-sm" />
            </div>
          ),
          thead: ({ node: _node, ...props }) => <thead {...props} className="bg-[hsl(0,0%,10%)]" />,
          th: ({ node: _node, ...props }) => (
            <th
              {...props}
              className="border border-[hsl(0,0%,16%)] px-3 py-2 font-medium text-[hsl(0,0%,84%)]"
            />
          ),
          td: ({ node: _node, ...props }) => (
            <td
              {...props}
              className="border border-[hsl(0,0%,16%)] px-3 py-2 text-[hsl(0,0%,74%)]"
            />
          ),
          hr: ({ node: _node, ...props }) => (
            <hr {...props} className="my-4 border-0 border-t border-[hsl(0,0%,16%)]" />
          ),
          h1: ({ node: _node, ...props }) => (
            <h1 {...props} className="mb-3 mt-1 text-2xl font-semibold tracking-tight text-[hsl(0,0%,92%)]" />
          ),
          h2: ({ node: _node, ...props }) => (
            <h2 {...props} className="mb-3 mt-4 text-xl font-semibold tracking-tight text-[hsl(0,0%,90%)]" />
          ),
          h3: ({ node: _node, ...props }) => (
            <h3 {...props} className="mb-2 mt-4 text-lg font-semibold tracking-tight text-[hsl(0,0%,88%)]" />
          ),
          h4: ({ node: _node, ...props }) => (
            <h4 {...props} className="mb-2 mt-3 text-base font-semibold text-[hsl(0,0%,86%)]" />
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
