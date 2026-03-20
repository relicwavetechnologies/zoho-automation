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
      <div className="max-w-3xl mx-auto px-6 py-6">
        {isLoadingOlderMessages && (
          <div className="mb-8 space-y-4 animate-in fade-in duration-500">
            <div className="flex flex-col gap-2 items-start">
              <Skeleton className="h-3 w-12 rounded ml-1" />
              <div className="w-full space-y-2">
                <Skeleton className="h-4 w-3/4 rounded-xl" />
                <Skeleton className="h-4 w-1/2 rounded-xl" />
              </div>
            </div>
          </div>
        )}

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
        {messages.length === 0 && !hasLiveExecution && !isThreadLoading && (
          <div className="text-center text-[hsl(0,0%,30%)] text-sm mt-16">
            Start a conversation below.
          </div>
        )}

        {isThreadLoading && messages.length === 0 && (
          <div className="space-y-10 mt-4 animate-in fade-in duration-700">
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex flex-col gap-2 items-start">
                <Skeleton className="h-3 w-12 rounded ml-1" />
                <div className="w-full space-y-3">
                  <Skeleton className="h-4 w-[90%] rounded-xl" />
                  <Skeleton className="h-4 w-[65%] rounded-xl" />
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
          <div className="mb-8">
            <div className="flex flex-col gap-2 items-start">
              {/* Name Only */}
              <span className="text-[10px] font-black uppercase tracking-[0.2em] text-primary/80 ml-1 opacity-50">
                Divo
              </span>

              <div className="min-w-0 w-full">
                {/*
                  When no blocks have arrived yet (request in flight, before first SSE),
                  show a "Reasoning..." shimmer so the user knows the request is being processed.
                  Once blocks arrive, they replace this indicator.
                */}
                {liveBlocks.length === 0 && (
                  <ThinkingShimmer label="Reasoning..." />
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
