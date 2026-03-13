import { useEffect, useMemo, useState } from 'react'
import type { Message } from '../types'
import { cn } from '../lib/utils'
import { Check, Copy, ExternalLink, FileText, Loader2, Share2 } from 'lucide-react'
import { MarkdownContent } from './MarkdownContent'
import { BlocksRenderer } from './BlocksRenderer'
import { useAuth } from '../context/AuthContext'

interface Props {
  message: Message
}

export function MessageBubble({ message }: Props): JSX.Element {
  const isUser = message.role === 'user'
  const [copied, setCopied] = useState(false)
  const [shareState, setShareState] = useState<'idle' | 'sharing' | 'shared' | 'failed'>('idle')
  const [shareMessage, setShareMessage] = useState<string | null>(null)
  const { token } = useAuth()

  useEffect(() => {
    if (!message.metadata?.shareAction?.shared) {
      setShareState('idle')
      setShareMessage(null)
      return
    }
    setShareState('shared')
    setShareMessage('Already shared to company scope.')
  }, [message.id, message.metadata?.shareAction?.shared])

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

  const displayContent = useMemo(() => {
    if (!isUser) return message.content
    return message.content
      .replace(/\n*!\[.*?\]\([^)]+\)/g, '')
      .replace(/\n*\[.*?\]\(attachment:[^)]+\)/g, '')
      .trim()
  }, [message.content, isUser])

  const shareConversation = async (): Promise<void> => {
    if (!token || !message.metadata?.shareAction || shareState === 'sharing') return

    setShareState('sharing')
    setShareMessage(null)
    try {
      const result = await window.desktopAPI.chat.share(token, message.threadId)
      const payload = result.data as { message?: string; data?: { status?: string; classification?: string } } | undefined
      if (!result.success) {
        setShareState('failed')
        setShareMessage(payload?.message ?? 'Failed to share this conversation.')
        return
      }

      const status = payload?.data?.status ?? 'processed'
      const classification = payload?.data?.classification
      setShareState('shared')
      setShareMessage(
        classification
          ? `Share ${status.replace(/_/g, ' ')} (${classification}).`
          : `Share ${status.replace(/_/g, ' ')}.`
      )
    } catch {
      setShareState('failed')
      setShareMessage('Failed to share this conversation.')
    }
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
          {message.metadata?.attachedFiles && message.metadata.attachedFiles.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2">
              {message.metadata.attachedFiles.map(file => (
                <div key={file.fileAssetId} className="relative group/file">
                  {file.mimeType.startsWith('image/') ? (
                    <img 
                      src={file.cloudinaryUrl} 
                      alt={file.fileName} 
                      className="w-16 h-16 rounded-xl object-cover border border-[hsl(0,0%,20%)] shadow-sm cursor-pointer hover:border-[hsl(0,0%,30%)] transition-colors"
                      title={file.fileName}
                      onClick={() => window.open(file.cloudinaryUrl, '_blank')}
                    />
                  ) : (
                    <div 
                      className="w-16 h-16 rounded-xl bg-[hsl(0,0%,15%)] border border-[hsl(0,0%,20%)] flex flex-col items-center justify-center gap-1 shadow-sm cursor-pointer hover:bg-[hsl(0,0%,18%)] transition-colors" 
                      title={file.fileName}
                      onClick={() => window.open(file.cloudinaryUrl, '_blank')}
                    >
                      {file.mimeType === 'application/pdf' ? <FileText size={18} className="text-red-400" /> : <FileText size={18} className="text-slate-400" />}
                      <span className="text-[9px] font-medium text-[hsl(0,0%,50%)] truncate w-full px-1 text-center">
                        {file.fileName.includes('.') ? file.fileName.slice(file.fileName.lastIndexOf('.') + 1).toUpperCase() : 'FILE'}
                      </span>
                    </div>
                  )}
                  {/* Tooltip */}
                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2 py-1 bg-[hsl(0,0%,10%)] border border-[hsl(0,0%,20%)] rounded text-[10px] text-[hsl(0,0%,80%)] whitespace-nowrap opacity-0 group-hover/file:opacity-100 transition-opacity pointer-events-none z-10 shadow-lg">
                    {file.fileName}
                  </div>
                </div>
              ))}
            </div>
          )}

          {!isUser && copyableResponse && (
            <div className="absolute right-0 top-0 z-10 flex gap-2 opacity-0 transition-all group-hover:opacity-100">
              <button
                onClick={() => void copyResponse()}
                className="rounded-xl border border-[hsl(0,0%,16%)] bg-[hsla(0,0%,6%,0.92)] px-2.5 py-1 text-[11px] font-medium text-[hsl(0,0%,64%)] hover:bg-[hsl(0,0%,10%)] hover:text-[hsl(0,0%,90%)]"
              >
                {copied ? <Check size={12} className="mr-1 inline-block" /> : <Copy size={12} className="mr-1 inline-block" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          )}
          {isUser ? (
            <p className="text-sm whitespace-pre-wrap break-words [overflow-wrap:anywhere] leading-relaxed text-[hsl(0,0%,85%)]">
              {displayContent}
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

          {!isUser && message.metadata?.citations && message.metadata.citations.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {message.metadata.citations.map((citation) => {
                const content = (
                  <>
                    <FileText size={11} className="text-[hsl(38,80%,55%)]" />
                    <span className="max-w-[240px] truncate">{citation.title}</span>
                    {citation.url && <ExternalLink size={10} className="text-[hsl(0,0%,45%)]" />}
                  </>
                )

                if (citation.url) {
                  return (
                    <a
                      key={citation.id}
                      href={citation.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-full border border-[hsl(0,0%,16%)] bg-[hsl(0,0%,8%)] px-3 py-1.5 text-[11px] text-[hsl(0,0%,70%)] hover:bg-[hsl(0,0%,10%)] hover:text-[hsl(0,0%,88%)]"
                    >
                      {content}
                    </a>
                  )
                }

                return (
                  <div
                    key={citation.id}
                    className="inline-flex items-center gap-1.5 rounded-full border border-[hsl(0,0%,16%)] bg-[hsl(0,0%,8%)] px-3 py-1.5 text-[11px] text-[hsl(0,0%,70%)]"
                  >
                    {content}
                  </div>
                )
              })}
            </div>
          )}

          {!isUser && message.metadata?.shareAction && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                onClick={() => void shareConversation()}
                disabled={shareState === 'sharing' || shareState === 'shared'}
                className="inline-flex items-center gap-1.5 rounded-full border border-[hsl(0,0%,16%)] bg-[hsl(0,0%,8%)] px-3 py-1.5 text-[11px] text-[hsl(0,0%,70%)] hover:bg-[hsl(0,0%,10%)] hover:text-[hsl(0,0%,88%)] disabled:cursor-not-allowed disabled:opacity-70"
              >
                {shareState === 'sharing' ? <Loader2 size={11} className="animate-spin" /> : <Share2 size={11} />}
                <span>{shareState === 'shared' ? 'Shared' : message.metadata.shareAction.label}</span>
              </button>
            </div>
          )}

          {!isUser && shareMessage && (
            <div
              className={cn(
                'mt-2 text-xs',
                shareState === 'failed' ? 'text-[hsl(0,50%,60%)]' : 'text-[hsl(140,45%,60%)]',
              )}
            >
              {shareMessage}
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
