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
    <div className={`${className ?? ''} break-words [overflow-wrap:anywhere]`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, href, ...props }) => {
            if (href?.startsWith('attachment:')) {
              // Extract the filename from the markdown children if possible
              const filename = flattenNodeText(props.children)
               return (
                 <div className="inline-flex mt-2 items-center justify-center flex-col gap-2 rounded-xl border border-border bg-secondary/30 w-[120px] h-[100px] hover:bg-secondary/50 transition-colors mb-2 mr-2 overflow-hidden shadow-sm">
                   <div className="w-10 h-10 rounded-lg bg-secondary/50 flex items-center justify-center border border-border">
                     {filename.match(/\.(jpg|jpeg|png|gif|webp)$/i) ? (
                       <Image size={18} className="text-primary/60" />
                     ) : filename.match(/\.pdf$/i) ? (
                       <FileText size={18} className="text-red-500/50" />
                     ) : (
                       <FileText size={18} className="text-muted-foreground/60" />
                     )}
                   </div>
                   <div className="text-[11px] font-medium text-muted-foreground/80 text-center w-full px-2 truncate leading-tight">
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
                className="font-semibold text-primary/80 underline decoration-primary/30 underline-offset-4 hover:text-primary transition-colors"
              />
            )
          },
          img: ({ node: _node, ...props }) => (
            <img {...props} className="mt-2 mb-3 max-w-full rounded-xl border border-border object-cover shadow-sm max-h-[250px]" alt={props.alt || 'Attachment'} />
          ),
          p: ({ node: _node, ...props }) => <p {...props} className="mb-4 whitespace-pre-wrap break-words [overflow-wrap:anywhere] leading-relaxed text-foreground/85 last:mb-0" />,
          ul: ({ node: _node, ...props }) => <ul {...props} className="mb-4 list-disc space-y-1.5 pl-6 text-foreground/85 last:mb-0" />,
          ol: ({ node: _node, ...props }) => <ol {...props} className="mb-4 list-decimal space-y-1.5 pl-6 text-foreground/85 last:mb-0" />,
          li: ({ node: _node, ...props }) => <li {...props} className="pl-1 break-words [overflow-wrap:anywhere] leading-relaxed" />,
          blockquote: ({ node: _node, ...props }) => (
            <blockquote
              {...props}
              className="my-5 rounded-r-xl border-l-2 border-primary/30 bg-secondary/20 px-4 py-3 text-muted-foreground italic"
            />
          ),
          strong: ({ node: _node, ...props }) => <strong {...props} className="font-bold text-foreground/90" />,
          em: ({ node: _node, ...props }) => <em {...props} className="italic text-foreground/80" />,
          code: ({ node: _node, className: codeClassName, children, ...props }) => {
            const inline = !codeClassName
            if (inline) {
              return (
                <code
                  {...props}
                  className="rounded bg-secondary/50 border border-border/50 px-1.5 py-0.5 text-[0.85em] font-mono text-primary/80"
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
              <div className="my-5 overflow-hidden rounded-2xl border border-border bg-black/20 shadow-sm">
                <div className="flex items-center justify-between border-b border-border/50 px-4 py-2 bg-secondary/10">
                  <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/40">
                    {languageLabel}
                  </span>
                  <button
                    onClick={() => void copyText(rawCode)}
                    className="rounded-lg border border-border bg-background px-2.5 py-1 text-[11px] font-semibold text-muted-foreground hover:bg-secondary hover:text-foreground transition-all"
                  >
                    {isCopied ? <Check size={12} className="mr-1 inline-block" /> : <Copy size={12} className="mr-1 inline-block" />}
                    {isCopied ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <pre
                  {...props}
                  className="overflow-x-auto p-4 text-[13px] leading-relaxed text-foreground/80 font-mono"
                >
                  {children}
                </pre>
              </div>
            )
          },
          table: ({ node: _node, ...props }) => (
            <div className="my-5 overflow-x-auto rounded-xl border border-border bg-secondary/5">
              <table {...props} className="min-w-full border-collapse text-left text-[13px]" />
            </div>
          ),
          thead: ({ node: _node, ...props }) => <thead {...props} className="bg-secondary/20" />,
          tbody: ({ node: _node, ...props }) => <tbody {...props} className="[&_tr:nth-child(even)]:bg-secondary/10" />,
          tr: ({ node: _node, ...props }) => <tr {...props} className="align-top" />,
          th: ({ node: _node, ...props }) => (
            <th
              {...props}
              className="border-b border-r border-border/50 px-4 py-2.5 font-bold uppercase tracking-wider text-muted-foreground/60 last:border-r-0"
            />
          ),
          td: ({ node: _node, ...props }) => (
            <td
              {...props}
              className="border-b border-r border-border/50 px-4 py-2.5 text-foreground/80 last:border-r-0"
            />
          ),
          hr: ({ node: _node, ...props }) => (
            <hr {...props} className="my-6 border-0 border-t border-border/50" />
          ),
          h1: ({ node: _node, ...props }) => (
            <h1 {...props} className="mb-4 mt-2 text-[24px] font-bold tracking-tight text-foreground/90" />
          ),
          h2: ({ node: _node, ...props }) => (
            <h2 {...props} className="mb-3 mt-6 text-[20px] font-bold tracking-tight text-foreground/90" />
          ),
          h3: ({ node: _node, ...props }) => (
            <h3 {...props} className="mb-2 mt-5 text-[18px] font-bold tracking-tight text-foreground/90" />
          ),
          h4: ({ node: _node, ...props }) => (
            <h4 {...props} className="mb-2 mt-4 text-[14px] font-bold uppercase tracking-widest text-muted-foreground/70" />
          ),
          input: ({ node: _node, ...props }) => (
            <input
              {...props}
              disabled
              className="mr-2 h-4 w-4 rounded border border-border accent-primary/60"
            />
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
