import { useEffect, useRef, useState } from 'react'
import { ArrowUpIcon } from 'lucide-react'
import type { SideChatTab } from '@/lib/auxiliary/types'
import { useAuxiliaryTabs } from '@/hooks/useAuxiliaryTabs'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const PLACEHOLDER_REPLY =
  'Side chat is ready as a parallel surface. Agent wiring comes next — for now notes stay local to this tab so the main thread stays clean.'

export function SideChatSurface({ tab }: { tab: SideChatTab }) {
  const appendSideChatMessage = useAuxiliaryTabs((s) => s.appendSideChatMessage)
  const [draft, setDraft] = useState('')
  const scrollerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [tab.messages.length])

  const send = () => {
    const content = draft.trim()
    if (!content) return
    appendSideChatMessage(tab.id, { role: 'user', content })
    setDraft('')
    window.setTimeout(() => {
      appendSideChatMessage(tab.id, {
        role: 'assistant',
        content: PLACEHOLDER_REPLY,
      })
    }, 280)
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {tab.parentThreadId ? (
        <div className="shrink-0 border-b border-border/60 px-3 py-2">
          <p className="truncate text-[11px] text-muted-foreground">
            Branched from main thread
            <span className="ml-1 font-mono text-muted-foreground/80">
              {tab.parentThreadId.slice(0, 8)}
            </span>
          </p>
        </div>
      ) : null}

      <div
        ref={scrollerRef}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3"
      >
        {tab.messages.length === 0 ? (
          <div className="flex h-full min-h-40 flex-col items-center justify-center px-4 text-center">
            <p className="text-sm text-foreground/85">Ask a side question</p>
            <p className="mt-1 max-w-[28ch] text-xs leading-5 text-muted-foreground">
              Explore a tangent without interrupting the main conversation.
            </p>
          </div>
        ) : (
          tab.messages.map((message) => (
            <div
              key={message.id}
              className={cn(
                'max-w-[92%] rounded-2xl px-3 py-2 text-sm leading-relaxed',
                message.role === 'user'
                  ? 'ml-auto bg-primary/15 text-foreground'
                  : 'mr-auto bg-muted/50 text-foreground/90'
              )}
            >
              {message.content}
            </div>
          ))
        )}
      </div>

      <div className="shrink-0 border-t border-border/70 p-3">
        <div className="flex items-end gap-2 rounded-2xl border border-border/80 bg-background px-2.5 py-2 shadow-xs">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
            rows={1}
            placeholder="Ask anything…"
            className="max-h-28 min-h-8 flex-1 resize-none bg-transparent py-1.5 text-sm outline-none placeholder:text-muted-foreground/70"
          />
          <Button
            type="button"
            size="icon-sm"
            className="shrink-0"
            disabled={!draft.trim()}
            onClick={send}
            aria-label="Send"
          >
            <ArrowUpIcon className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}
