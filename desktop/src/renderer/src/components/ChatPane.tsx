import { useEffect, useRef } from 'react'
import { useChat } from '../context/ChatContext'
import { MessageBubble } from './MessageBubble'
import { EmptyThread } from './EmptyThread'
import { ActivityBar, ThinkingShimmer } from './ActivityBar'
import { MarkdownContent } from './MarkdownContent'

export function ChatPane(): JSX.Element {
  const {
    messages,
    isStreaming,
    streamingText,
    activitySteps,
    activeThread,
    error,
    clearError,
  } = useChat()
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamingText, activitySteps])

  if (!activeThread) {
    return <EmptyThread />
  }

  return (
    <div className="flex-1 overflow-y-auto">
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

        {/* ── Live agentic response area ─────────────────────────────── */}
        {isStreaming && (
          <div className="mb-4">
            <div className="flex gap-3">
              {/* AI avatar */}
              <div className="shrink-0 mt-0.5 h-6 w-6 rounded-md bg-[hsl(0,0%,14%)] flex items-center justify-center">
                <span className="text-[10px] font-semibold text-[hsl(0,0%,50%)]">AI</span>
              </div>

              <div className="min-w-0 flex-1">
                {/* 1. Thinking shimmer — shows immediately on send while no text/steps yet */}
                {!streamingText && activitySteps.length === 0 && (
                  <ThinkingShimmer />
                )}

                {/* 2. Activity feed — live tool steps, dim colored */}
                {activitySteps.length > 0 && (
                  <ActivityBar steps={activitySteps} />
                )}

                {/* 3. Streaming AI text — bright white, appears after tool steps complete */}
                {streamingText && (
                  <div className="streaming-cursor mt-1">
                    <MarkdownContent
                      content={streamingText}
                      className="desktop-markdown text-sm leading-relaxed text-[hsl(0,0%,88%)]"
                    />
                  </div>
                )}

                {/* 4. Waiting dots — should never be seen since shimmer covers it, but kept as safety net */}
                {false && (
                  <div className="flex gap-1 pt-1">
                    <span className="h-1.5 w-1.5 rounded-full bg-[hsl(0,0%,28%)] animate-pulse" style={{ animationDelay: '0ms' }} />
                    <span className="h-1.5 w-1.5 rounded-full bg-[hsl(0,0%,28%)] animate-pulse" style={{ animationDelay: '200ms' }} />
                    <span className="h-1.5 w-1.5 rounded-full bg-[hsl(0,0%,28%)] animate-pulse" style={{ animationDelay: '400ms' }} />
                  </div>
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
