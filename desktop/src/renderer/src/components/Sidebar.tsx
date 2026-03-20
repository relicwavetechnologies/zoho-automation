import { useEffect, useRef, useState } from 'react'
import { Plus, Search, Trash2, PanelLeftClose, SquarePen, Settings, Workflow, MessageSquareText } from 'lucide-react'
import { cn } from '../lib/utils'
import { useChat } from '../context/ChatContext'
import { useWorkspace } from '../context/WorkspaceContext'
import type { Thread } from '../types'

export function Sidebar({
  isOpen,
  onToggle,
  onSettingsClick,
  onChatClick,
  onScheduleClick,
  currentView,
}: {
  isOpen: boolean
  onToggle: () => void
  onSettingsClick?: () => void
  onChatClick?: () => void
  onScheduleClick?: () => void
  currentView?: 'chat' | 'schedule' | 'settings'
}): JSX.Element | null {
  const { threads, activeThread, loadThreads, selectThread, createThread, isStreaming } = useChat()
  const { currentWorkspace, selectWorkspace, getThreadWorkspace } = useWorkspace()
  const [filter, setFilter] = useState('')
  const loadedRef = useRef(false)

  useEffect(() => {
    if (!loadedRef.current) {
      loadedRef.current = true
      loadThreads()
    }
  }, [loadThreads])

  if (!isOpen) return null

  const filtered = filter
    ? threads.filter(
      (t) =>
        (t.title ?? 'New thread').toLowerCase().includes(filter.toLowerCase()),
    )
    : threads

  const handleNewThread = async (): Promise<void> => {
    onChatClick?.()
    await createThread()
  }

  return (
    <div
      className="flex h-full min-h-0 shrink-0 flex-col overflow-hidden border-r-0"
      style={{
        width: 260,
        background: 'hsl(var(--sidebar-bg))',
      }}
    >
      {/* Top action bar: Toggle & New Chat */}
      <div className="titlebar-drag h-12 flex items-center justify-between px-3 shrink-0">
        <button
          onClick={onToggle}
          title="Close Sidebar"
          className="titlebar-no-drag p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-sidebar-hover transition-colors"
        >
          <PanelLeftClose size={16} />
        </button>
        <button
          onClick={handleNewThread}
          title="New Chat"
          disabled={isStreaming}
          className="titlebar-no-drag p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-sidebar-hover transition-colors disabled:cursor-not-allowed disabled:opacity-40"
        >
          <SquarePen size={16} />
        </button>
      </div>

      <div className="shrink-0 px-3 py-2">
        {currentWorkspace && (
          <div className="mb-4 rounded-xl border border-border bg-secondary/20 px-3.5 py-3 shadow-sm">
            <div className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50">Workspace</div>
            <div className="mt-1 truncate text-[13px] font-semibold text-foreground/90">{currentWorkspace.name}</div>
            <div className="mt-0.5 truncate text-[10px] text-muted-foreground/40 font-medium">{currentWorkspace.path}</div>
            <button
              onClick={() => void selectWorkspace()}
              className="mt-3 text-[10px] font-bold uppercase tracking-wider text-primary/70 hover:text-primary transition-colors"
            >
              Switch Folder
            </button>
          </div>
        )}

        {/* Top pinned items */}
        <div className="pb-4">
          <div className="mb-3 grid grid-cols-2 gap-2">
            <button
              onClick={onChatClick}
              className={cn(
                'flex items-center justify-center gap-2 rounded-lg border h-8 text-[11px] font-bold uppercase tracking-wider transition-all',
                currentView === 'chat'
                  ? 'bg-secondary text-foreground border-border shadow-sm'
                  : 'text-muted-foreground/60 hover:bg-secondary/50 hover:text-foreground border-transparent',
              )}
            >
              <MessageSquareText size={13} />
              Chat
            </button>
            <button
              onClick={onScheduleClick}
              className={cn(
                'flex items-center justify-center gap-2 rounded-lg border h-8 text-[11px] font-bold uppercase tracking-wider transition-all',
                currentView === 'schedule'
                  ? 'bg-secondary text-foreground border-border shadow-sm'
                  : 'text-muted-foreground/60 hover:bg-secondary/50 hover:text-foreground border-transparent',
              )}
            >
              <Workflow size={13} />
              Workflows
            </button>
          </div>

          <div className="relative">
            <Search
              size={12}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/40"
            />
            <input
              type="text"
              placeholder="Search history..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              disabled={isStreaming}
              className={cn(
                'w-full pl-8 pr-2 h-8 rounded-lg text-[12px]',
                'bg-secondary/30 border-transparent focus:border-border',
                'text-foreground/80 placeholder:text-muted-foreground/30',
                'focus:outline-none transition-all border disabled:cursor-not-allowed disabled:opacity-50',
              )}
            />
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-2 pb-2">
        <div className="px-2 pb-2 pt-1">
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
            Threads
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {filtered.length === 0 && (
            <div className="mt-8 px-4 text-center text-xs text-muted-foreground/40">
              {threads.length === 0
                ? 'No threads yet.'
                : 'No matching threads.'}
            </div>
          )}
          {filtered.map((thread) => (
            <ThreadItem
              key={thread.id}
              thread={thread}
              isActive={activeThread?.id === thread.id}
              disabled={isStreaming}
              onClick={() => selectThread(thread.id)}
              workspaceName={getThreadWorkspace(thread.id)?.name ?? null}
            />
          ))}
        </div>
      </div>

      {/* Bottom settings area */}
      <div className="p-3 shrink-0 flex items-center">
        <button 
          onClick={onSettingsClick}
          className="flex items-center gap-2 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          <Settings size={14} />
          Settings
        </button>
      </div>

    </div>
  )
}

function ThreadItem({
  thread,
  isActive,
  disabled,
  onClick,
  workspaceName,
}: {
  thread: Thread
  isActive: boolean
  disabled?: boolean
  onClick: () => void
  workspaceName: string | null
}): JSX.Element {
  const { deleteThread } = useChat()
  const title = thread.title ?? 'New thread'
  // Simplified time format for tighter sidebar
  const time = thread.lastMessageAt
    ? formatRelativeTimeShort(new Date(thread.lastMessageAt))
    : ''

  const handleDelete = async (e: React.MouseEvent): Promise<void> => {
    e.stopPropagation()
    if (!window.confirm(`Delete "${title}"?`)) return
    await deleteThread(thread.id)
  }

  return (
    <div className="relative group mx-1">
      <button
        onClick={onClick}
        disabled={disabled}
        className={cn(
          'w-full text-left px-2.5 py-[8px] rounded-lg transition-colors pr-8',
          disabled && 'cursor-not-allowed opacity-50',
          isActive
            ? 'bg-sidebar-active text-white'
            : 'text-muted-foreground/80 hover:bg-sidebar-hover hover:text-foreground',
        )}
      >
        <div className="flex items-baseline justify-between gap-3">
          <div className="min-w-0">
            <span className={cn("block text-[13px] truncate", isActive ? "font-medium" : "font-normal")}>
              {title}
            </span>
            {workspaceName && (
              <span className="block text-[10px] truncate text-muted-foreground/50">
                {workspaceName}
              </span>
            )}
          </div>
          {time && (
            <span className={cn(
              "text-[10px] shrink-0",
              isActive ? "text-white/60" : "text-muted-foreground/40"
            )}>
              {time}
            </span>
          )}
        </div>
      </button>

      {/* Delete button — appears on hover */}
      <button
        onClick={handleDelete}
        title="Delete thread"
        disabled={disabled}
        className={cn(
          'absolute right-1.5 top-1/2 -translate-y-1/2',
          'p-[3px] rounded opacity-0 group-hover:opacity-100 transition-opacity',
          disabled && 'cursor-not-allowed opacity-0',
          isActive
            ? 'text-white/40 hover:text-white/80 focus:opacity-100 hover:bg-white/10'
            : 'text-muted-foreground/40 hover:text-red-400 focus:opacity-100 hover:bg-muted',
        )}
      >
        <Trash2 size={13} />
      </button>
    </div>
  )
}

function formatRelativeTimeShort(date: Date): string {
  const now = Date.now()
  const diff = now - date.getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days}d`
  const weeks = Math.floor(days / 7)
  if (weeks < 4) return `${weeks}w`
  return date.toLocaleDateString(undefined, { month: 'short' })
}
