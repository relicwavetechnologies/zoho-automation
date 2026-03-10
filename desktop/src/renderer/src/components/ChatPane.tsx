import { useEffect, useRef } from 'react'
import { useChat } from '../context/ChatContext'
import { MessageBubble } from './MessageBubble'
import { EmptyThread } from './EmptyThread'
import { ThinkingShimmer } from './ActivityBar'
import { BlocksRenderer } from './BlocksRenderer'

export function ChatPane(): JSX.Element {
  const {
    messages,
    isStreaming,
    liveBlocks,
    activeThread,
    error,
    clearError,
  } = useChat()
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, liveBlocks.length])

  if (!activeThread) return <EmptyThread />

  return (
    <div className="flex-1 overflow-y-auto titlebar-no-drag">
      <div className="max-w-3xl mx-auto px-6 py-6">
        {/* Error banner */}
        {error && (
          <div className="mb-4 flex items-center justify-between px-3 py-2 rounded-lg bg-[hsl(0,40%,12%)] border border-[hsl(0,40%,22%)]">
            <span className="text-sm text-[hsl(0,50%,65%)]">{error}</span>
            <button
              onClick={clearError}
              className="text-xs text-[hsl(0,0%,50%)] hover:text-[hsl(0,0%,70%)] ml-3"
            >
              dismiss
            </button>
          </div>
        )}

        {/* Messages */}
        {messages.length === 0 && !isStreaming && (
          <div className="text-center text-[hsl(0,0%,30%)] text-sm mt-16">
            Start a conversation below.
          </div>
        )}

        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}

        {/* ── Live agentic response ─────────────────────────────────────── */}
        {isStreaming && (
          <div className="mb-4">
            <div className="flex gap-3">
              {/* AI avatar */}
              <div className="shrink-0 mt-0.5 h-6 w-6 rounded-md bg-[hsl(0,0%,14%)] flex items-center justify-center">
                <span className="text-[10px] font-semibold text-[hsl(0,0%,50%)]">AI</span>
              </div>

              <div className="min-w-0 flex-1">
                {/*
                  When no blocks have arrived yet (request in flight, before first SSE),
                  show a "Working..." shimmer so the user knows the request is being processed.
                  Once blocks arrive, they replace this indicator.
                */}
                {liveBlocks.length === 0 && (
                  <ThinkingShimmer label="Working..." />
                )}

                {/* Ordered timeline — tool rows, thinking shimmer/labels, text blocks */}
                {liveBlocks.length > 0 && (
                  <BlocksRenderer blocks={liveBlocks} isStreaming />
                )}
              </div>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>
    </div>
  )
}
