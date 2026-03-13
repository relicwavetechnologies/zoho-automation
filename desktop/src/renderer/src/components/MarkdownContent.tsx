import { Children, isValidElement, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Check, Copy, FileText, Image } from 'lucide-react'

interface Props {
  content: string
  className?: string
}

function flattenNodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(flattenNodeText).join('')
  if (isValidElement(node)) return flattenNodeText(node.props.children)
  return ''
}

export function MarkdownContent({ content, className }: Props): JSX.Element {
  const [copiedCode, setCopiedCode] = useState<string | null>(null)

  const copyText = async (value: string): Promise<void> => {
    await navigator.clipboard.writeText(value)
    setCopiedCode(value)
    window.setTimeout(() => {
      setCopiedCode((current) => (current === value ? null : current))
    }, 1200)
  }

  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, href, ...props }) => {
            if (href?.startsWith('attachment:')) {
              // Extract the filename from the markdown children if possible
              const filename = flattenNodeText(props.children)
               return (
                 <div className="inline-flex mt-2 items-center justify-center flex-col gap-2 rounded-xl border border-[hsl(0,0%,16%)] bg-[hsl(0,0%,11%)] w-[120px] h-[100px] hover:bg-[hsl(0,0%,16%)] transition-colors mb-2 mr-2 overflow-hidden shadow-sm">
                   <div className="w-10 h-10 rounded-lg bg-[hsl(0,0%,15%)] flex items-center justify-center border border-[hsl(0,0%,20%)]">
                     {filename.match(/\.(jpg|jpeg|png|gif|webp)$/i) ? (
                       <Image size={18} className="text-blue-400" />
                     ) : filename.match(/\.pdf$/i) ? (
                       <FileText size={18} className="text-red-400" />
                     ) : (
                       <FileText size={18} className="text-slate-400" />
                     )}
                   </div>
                   <div className="text-[11px] font-medium text-[hsl(0,0%,70%)] text-center w-full px-2 truncate leading-tight">
                     {filename}
                   </div>
                 </div>
               )
            }
            return (
              <a
                {...props}
                href={href}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-[hsl(210,85%,72%)] underline decoration-[hsl(210,70%,54%)] underline-offset-4 hover:text-[hsl(210,85%,80%)]"
              />
            )
          },
          img: ({ node: _node, ...props }) => (
            <img {...props} className="mt-2 mb-3 max-w-full rounded-xl border border-[hsl(0,0%,16%)] object-cover shadow-sm max-h-[250px]" alt={props.alt || 'Attachment'} />
          ),
          p: ({ node: _node, ...props }) => <p {...props} className="mb-4 leading-8 text-[15px] text-[hsl(0,0%,80%)] last:mb-0" />,
          ul: ({ node: _node, ...props }) => <ul {...props} className="mb-4 list-disc space-y-1.5 pl-6 last:mb-0" />,
          ol: ({ node: _node, ...props }) => <ol {...props} className="mb-4 list-decimal space-y-1.5 pl-6 last:mb-0" />,
          li: ({ node: _node, ...props }) => <li {...props} className="pl-1 text-[15px] leading-8 text-[hsl(0,0%,78%)]" />,
          blockquote: ({ node: _node, ...props }) => (
            <blockquote
              {...props}
              className="my-5 rounded-r-2xl border-l-2 border-[hsl(45,84%,58%)] bg-[hsl(0,0%,7%)] px-4 py-3 text-[hsl(0,0%,66%)]"
            />
          ),
          strong: ({ node: _node, ...props }) => <strong {...props} className="font-semibold text-[hsl(0,0%,94%)]" />,
          em: ({ node: _node, ...props }) => <em {...props} className="italic text-[hsl(0,0%,86%)]" />,
          code: ({ node: _node, className: codeClassName, children, ...props }) => {
            const inline = !codeClassName
            if (inline) {
              return (
                <code
                  {...props}
                  className="rounded-md border border-[hsl(0,0%,14%)] bg-[hsl(0,0%,8%)] px-1.5 py-0.5 text-[0.8rem] text-[hsl(45,84%,74%)]"
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
          pre: ({ node: _node, children, ...props }) => {
            let languageLabel = 'code'
            const firstChild = Children.toArray(children)[0]
            if (isValidElement(firstChild) && typeof firstChild.props.className === 'string') {
              languageLabel = firstChild.props.className.replace('language-', '') || 'code'
            }
            const rawCode = flattenNodeText(children).replace(/\n$/, '')
            const isCopied = copiedCode === rawCode

            return (
              <div className="my-5 overflow-hidden rounded-2xl border border-[hsl(0,0%,14%)] bg-[linear-gradient(180deg,hsl(0,0%,9%),hsl(0,0%,6%))] shadow-[0_12px_24px_rgba(0,0,0,0.18)]">
                <div className="flex items-center justify-between border-b border-[hsl(0,0%,14%)] px-4 py-2">
                  <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-[hsl(0,0%,46%)]">
                    {languageLabel}
                  </span>
                  <button
                    onClick={() => void copyText(rawCode)}
                    className="rounded-lg border border-[hsl(0,0%,16%)] px-2.5 py-1 text-[11px] font-medium text-[hsl(0,0%,64%)] hover:bg-[hsl(0,0%,10%)] hover:text-[hsl(0,0%,90%)]"
                  >
                    {isCopied ? <Check size={12} className="mr-1 inline-block" /> : <Copy size={12} className="mr-1 inline-block" />}
                    {isCopied ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <pre
                  {...props}
                  className="overflow-x-auto p-4 text-[hsl(0,0%,84%)]"
                >
                  {children}
                </pre>
              </div>
            )
          },
          table: ({ node: _node, ...props }) => (
            <div className="my-5 overflow-x-auto rounded-2xl border border-[hsl(0,0%,14%)] bg-[hsl(0,0%,6%)]">
              <table {...props} className="min-w-full border-collapse text-left text-sm" />
            </div>
          ),
          thead: ({ node: _node, ...props }) => <thead {...props} className="bg-[hsl(0,0%,10%)]" />,
          tbody: ({ node: _node, ...props }) => <tbody {...props} className="[&_tr:nth-child(even)]:bg-[hsl(0,0%,7%)]" />,
          tr: ({ node: _node, ...props }) => <tr {...props} className="align-top" />,
          th: ({ node: _node, ...props }) => (
            <th
              {...props}
              className="border-b border-r border-[hsl(0,0%,14%)] px-4 py-3 text-[12px] font-semibold uppercase tracking-[0.08em] text-[hsl(0,0%,68%)] last:border-r-0"
            />
          ),
          td: ({ node: _node, ...props }) => (
            <td
              {...props}
              className="border-b border-r border-[hsl(0,0%,12%)] px-4 py-3 text-[15px] leading-7 text-[hsl(0,0%,82%)] last:border-r-0"
            />
          ),
          hr: ({ node: _node, ...props }) => (
            <hr {...props} className="my-6 border-0 border-t border-[hsl(0,0%,14%)]" />
          ),
          h1: ({ node: _node, ...props }) => (
            <h1 {...props} className="mb-4 mt-1 text-[30px] font-semibold tracking-[-0.03em] text-[hsl(0,0%,96%)]" />
          ),
          h2: ({ node: _node, ...props }) => (
            <h2 {...props} className="mb-3 mt-7 text-[22px] font-semibold tracking-[-0.02em] text-[hsl(0,0%,92%)]" />
          ),
          h3: ({ node: _node, ...props }) => (
            <h3 {...props} className="mb-2 mt-6 text-[18px] font-semibold tracking-[-0.01em] text-[hsl(0,0%,90%)]" />
          ),
          h4: ({ node: _node, ...props }) => (
            <h4 {...props} className="mb-2 mt-5 text-[15px] font-semibold uppercase tracking-[0.08em] text-[hsl(0,0%,72%)]" />
          ),
          input: ({ node: _node, ...props }) => (
            <input
              {...props}
              disabled
              className="mr-2 h-4 w-4 rounded border border-[hsl(0,0%,18%)] accent-[hsl(45,84%,58%)]"
            />
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
