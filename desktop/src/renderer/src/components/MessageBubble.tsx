import { useMemo, useState } from 'react'
import type { Message } from '../types'
import { cn } from '../lib/utils'
import { Check, Copy, FileText } from 'lucide-react'
import { MarkdownContent } from './MarkdownContent'
import { BlocksRenderer } from './BlocksRenderer'

interface Props {
  message: Message
}

export function MessageBubble({ message }: Props): JSX.Element {
  const isUser = message.role === 'user'
  const [copied, setCopied] = useState(false)

  // Use contentBlocks (new) if available, else fall back to rendering content as text
  const blocks = message.metadata?.contentBlocks
  const copyableResponse = useMemo(() => {
    if (message.content.trim()) return message.content
    if (!blocks || blocks.length === 0) return ''
    return blocks
      .map((block) => {
        if (block.type === 'text') return block.content
        if (block.type === 'tool') return block.resultSummary ? `${block.label}\n${block.resultSummary}` : block.label
        if (block.type === 'terminal') {
          return [`$ ${block.command}`, block.stdout, block.stderr].filter(Boolean).join('\n')
        }
        return ''
      })
      .filter(Boolean)
      .join('\n\n')
      .trim()
  }, [blocks, message.content])

  const copyResponse = async (): Promise<void> => {
    if (!copyableResponse) return
    await navigator.clipboard.writeText(copyableResponse)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1200)
  }

  return (
    <div className="group mb-4">
      <div className="flex gap-3">
        {/* Avatar */}
        <div
          className={cn(
            'shrink-0 mt-0.5 h-6 w-6 rounded-md flex items-center justify-center',
            isUser ? 'bg-[hsl(0,0%,20%)]' : 'bg-[hsl(0,0%,14%)]',
          )}
        >
          <span className="text-[10px] font-semibold text-[hsl(0,0%,50%)]">
            {isUser ? 'U' : 'AI'}
          </span>
        </div>

        {/* Content */}
        <div className="relative min-w-0 flex-1">
          {!isUser && copyableResponse && (
            <button
              onClick={() => void copyResponse()}
              className="absolute right-0 top-0 z-10 rounded-xl border border-[hsl(0,0%,16%)] bg-[hsla(0,0%,6%,0.92)] px-2.5 py-1 text-[11px] font-medium text-[hsl(0,0%,64%)] opacity-0 transition-all hover:bg-[hsl(0,0%,10%)] hover:text-[hsl(0,0%,90%)] group-hover:opacity-100"
            >
              {copied ? <Check size={12} className="mr-1 inline-block" /> : <Copy size={12} className="mr-1 inline-block" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          )}
          {isUser ? (
            <p className="text-sm whitespace-pre-wrap leading-relaxed text-[hsl(0,0%,85%)]">
              {message.content}
            </p>
          ) : blocks && blocks.length > 0 ? (
            // New: render ordered content blocks (tool rows + text interleaved)
            <BlocksRenderer blocks={blocks} isStreaming={false} />
          ) : (
            // Legacy fallback: plain markdown text
            <MarkdownContent
              content={message.content}
              className="desktop-markdown text-sm leading-relaxed text-[hsl(0,0%,78%)]"
            />
          )}

          {/* Lark doc references */}
          {message.metadata?.larkDocs && message.metadata.larkDocs.length > 0 && (
            <div className="mt-2 flex flex-col gap-1">
              {message.metadata.larkDocs.map((doc) => (
                <div
                  key={doc.documentId}
                  className="flex items-center gap-2 px-2 py-1 rounded bg-[hsl(0,0%,8%)] border border-[hsl(0,0%,14%)]"
                >
                  <FileText size={12} className="text-[hsl(38,80%,55%)]" />
                  <span className="text-xs text-[hsl(0,0%,60%)]">{doc.title}</span>
                </div>
              ))}
            </div>
          )}

          {/* Error */}
          {message.metadata?.error && (
            <div className="mt-2 px-2 py-1 rounded bg-[hsl(0,40%,10%)] border border-[hsl(0,40%,20%)]">
              <span className="text-xs text-[hsl(0,50%,60%)]">{message.metadata.error}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
