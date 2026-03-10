import { useState, useRef, useEffect } from 'react'
import { ArrowUp, AtSign, ChevronDown, Image as ImageIcon, Infinity } from 'lucide-react'
import { cn } from '../lib/utils'
import { useChat } from '../context/ChatContext'
import { useWorkspace } from '../context/WorkspaceContext'

export function Composer(): JSX.Element {
  const { sendMessage, isStreaming, activeThread } = useChat()
  const { currentWorkspace } = useWorkspace()
  const [text, setText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const canSend = text.trim().length > 0 && !isStreaming && !!activeThread

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 160)}px`
    }
  }, [text])

  const handleSend = (): void => {
    if (!canSend) return
    sendMessage(text.trim())
    setText('')
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className="shrink-0 px-5 py-3 titlebar-no-drag">
      <div className="max-w-[760px] mx-auto">
        <div
          className={cn(
            'rounded-[20px] border px-3.5 pt-3 pb-2.5 shadow-[0_12px_24px_rgba(0,0,0,0.2),inset_0_1px_0_rgba(255,255,255,0.03)]',
            'bg-[linear-gradient(180deg,hsl(0,0%,9%),hsl(0,0%,7%))]',
            activeThread
              ? 'border-[hsl(0,0%,16%)] focus-within:border-[hsl(216,14%,28%)]'
              : 'border-[hsl(0,0%,16%)] opacity-60',
          )}
        >
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              activeThread
                ? `Ask about ${currentWorkspace?.name ?? 'this workspace'} or run /run <command>`
                : currentWorkspace
                  ? `Create a thread in ${currentWorkspace.name} to start`
                  : 'Open a workspace folder to start'
            }
            disabled={!activeThread}
            rows={1}
            className={cn(
              'w-full resize-none bg-transparent text-[15px] leading-6 tracking-[-0.01em]',
              'text-[hsl(0,0%,89%)] placeholder:text-[hsl(0,0%,46%)]',
              'focus:outline-none',
              'disabled:cursor-not-allowed',
              'min-h-[44px]',
            )}
          />

          <div className="mt-2.5 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <button
                type="button"
                disabled
                className="inline-flex h-8 items-center gap-2 rounded-xl border border-[hsl(0,0%,24%)] bg-[hsl(0,0%,22%)] px-3 text-[13px] font-medium text-[hsl(0,0%,80%)] shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] disabled:cursor-default"
              >
                <Infinity size={14} />
                <span>Agent</span>
                <ChevronDown size={13} className="text-[hsl(0,0%,60%)]" />
              </button>
              <button
                type="button"
                disabled
                className="inline-flex h-8 items-center gap-1 rounded-xl px-1 text-[13px] font-medium text-[hsl(0,0%,72%)] disabled:cursor-default"
              >
                Auto
                <ChevronDown size={13} className="text-[hsl(0,0%,56%)]" />
              </button>
            </div>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                disabled
                className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-[hsl(0,0%,48%)] hover:bg-[hsl(0,0%,21%)] disabled:cursor-default"
                title="@ mentions coming soon"
              >
                <AtSign size={15} />
              </button>
              <button
                type="button"
                disabled
                className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-[hsl(0,0%,48%)] hover:bg-[hsl(0,0%,21%)] disabled:cursor-default"
                title="Attachments coming soon"
              >
                <ImageIcon size={15} />
              </button>
              <button
                onClick={handleSend}
                disabled={!canSend}
                className={cn(
                  'ml-1 shrink-0 h-8 w-8 rounded-xl flex items-center justify-center border transition-all',
                  canSend
                    ? 'border-[hsl(138,67%,44%)] bg-[hsl(138,67%,48%)] text-[hsl(0,0%,7%)] shadow-[0_10px_24px_rgba(34,197,94,0.22)] hover:bg-[hsl(138,67%,45%)]'
                    : 'border-[hsl(0,0%,24%)] bg-[hsl(0,0%,24%)] text-[hsl(0,0%,38%)]',
                )}
              >
                <ArrowUp size={14} />
              </button>
            </div>
          </div>
        </div>
        <p className="mt-1.5 text-center text-[9px] tracking-[0.02em] text-[hsl(0,0%,28%)]">
          {currentWorkspace
            ? `Threads are scoped to ${currentWorkspace.name}. Use /run to execute a shell command here.`
            : 'Open a workspace folder to begin.'}
        </p>
      </div>
    </div>
  )
}
