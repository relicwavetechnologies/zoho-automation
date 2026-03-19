import { useCallback, useLayoutEffect, useRef } from 'react'
import { useChat } from '../context/ChatContext'
import { MessageBubble } from './MessageBubble'
import { EmptyThread } from './EmptyThread'
import { Skeleton } from './ui/Skeleton'
import { ThinkingShimmer } from './ActivityBar'
import { BlocksRenderer } from './BlocksRenderer'

export function ChatPane(): JSX.Element {
  const {
    messages,
    isThreadLoading,
    isLoadingOlderMessages,
    hasMoreHistory,
    isStreaming,
    isThinking,
    liveBlocks,
    activeThread,
    error,
    clearError,
    loadOlderMessages,
  } = useChat()
  const hasLiveExecution = isStreaming || isThinking || liveBlocks.length > 0
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const restoreScrollRef = useRef<{ previousHeight: number; previousTop: number } | null>(null)
  const previousStateRef = useRef<{
    threadId: string | null
    lastMessageId: string | null
    liveBlocksLength: number
  }>({
    threadId: null,
    lastMessageId: null,
    liveBlocksLength: 0,
  })

  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current
    if (!container || isThreadLoading || isLoadingOlderMessages || !hasMoreHistory) {
      return
    }

    if (container.scrollTop <= 80) {
      restoreScrollRef.current = {
        previousHeight: container.scrollHeight,
        previousTop: container.scrollTop,
      }
      void loadOlderMessages()
    }
  }, [hasMoreHistory, isLoadingOlderMessages, isThreadLoading, loadOlderMessages])

  useLayoutEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return

    if (restoreScrollRef.current) {
      const restore = restoreScrollRef.current
      restoreScrollRef.current = null
      container.scrollTop = container.scrollHeight - restore.previousHeight + restore.previousTop
    } else {
      const previous = previousStateRef.current
      const currentLastMessageId = messages[messages.length - 1]?.id ?? null
      const threadChanged = previous.threadId !== (activeThread?.id ?? null)
      const lastMessageChanged = previous.lastMessageId !== currentLastMessageId
      const liveBlocksChanged = previous.liveBlocksLength !== liveBlocks.length
      const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight
      const shouldStickToBottom = threadChanged || distanceFromBottom <= 120 || hasLiveExecution

      if ((threadChanged || lastMessageChanged || liveBlocksChanged) && shouldStickToBottom) {
        bottomRef.current?.scrollIntoView({ behavior: threadChanged ? 'auto' : 'smooth' })
      }
    }

    previousStateRef.current = {
      threadId: activeThread?.id ?? null,
      lastMessageId: messages[messages.length - 1]?.id ?? null,
      liveBlocksLength: liveBlocks.length,
    }
  }, [activeThread?.id, hasLiveExecution, liveBlocks.length, messages])

  if (!activeThread) return <EmptyThread />

  return (
    <div
      ref={scrollContainerRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto titlebar-no-drag"
    >
      <div className="max-w-4xl mx-auto px-6 py-6">
        {isLoadingOlderMessages && (
          <div className="glass-panel mb-8 space-y-4 rounded-[28px] px-5 py-5 animate-in fade-in duration-500">
            <div className="flex gap-3">
              <Skeleton className="h-6 w-6 shrink-0" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
              </div>
            </div>
          </div>
        )}

        {/* Error banner */}
        {error && (
          <div className="mb-4 flex items-center justify-between px-4 py-3 rounded-2xl border border-red-300/15 bg-red-500/10 backdrop-blur-xl">
            <span className="text-sm text-red-100/80">{error}</span>
            <button
              onClick={clearError}
              className="text-xs text-white/45 hover:text-white/72 ml-3"
            >
              dismiss
            </button>
          </div>
        )}

        {/* Messages */}
        {messages.length === 0 && !hasLiveExecution && !isThreadLoading && (
          <div className="text-center text-[hsl(0,0%,30%)] text-sm mt-16">
            Start a conversation below.
          </div>
        )}

        {isThreadLoading && messages.length === 0 && (
          <div className="space-y-10 mt-4 animate-in fade-in duration-700">
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex gap-4">
                <Skeleton className="h-7 w-7 rounded-lg shrink-0" />
                <div className="flex-1 space-y-3 pt-1">
                  <Skeleton className="h-4 w-[90%]" />
                  <Skeleton className="h-4 w-[65%]" />
                  {i === 1 && <Skeleton className="h-4 w-[45%]" />}
                </div>
              </div>
            ))}
          </div>
        )}

        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}

        {/* ── Live agentic response ─────────────────────────────────────── */}
        {hasLiveExecution && (
          <div className="mb-4">
            <div className="flex gap-3">
              {/* AI avatar */}
              <div className="shrink-0 mt-0.5 h-7 w-7 rounded-xl border border-sky-300/12 bg-sky-400/8 flex items-center justify-center shadow-[0_10px_24px_rgba(0,0,0,0.22)]">
                <span className="text-[10px] font-semibold text-sky-100/70">AI</span>
              </div>

              <div className="glass-panel min-w-0 flex-1 rounded-[24px] px-4 py-4">
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
