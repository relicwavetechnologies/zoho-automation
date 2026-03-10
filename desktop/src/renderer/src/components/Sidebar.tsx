import { useEffect, useRef, useState } from 'react'
import { Plus, Search, Trash2, PanelLeftClose, PanelRightClose, SquarePen, Settings, Sparkles } from 'lucide-react'
import { cn } from '../lib/utils'
import { useChat } from '../context/ChatContext'
import { useWorkspace } from '../context/WorkspaceContext'
import type { Thread } from '../types'

export function Sidebar({ isOpen, onToggle }: { isOpen: boolean; onToggle: () => void }): JSX.Element | null {
  const { threads, activeThread, loadThreads, selectThread, createThread } = useChat()
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
    await createThread()
  }

  return (
    <div
      className="flex flex-col h-full shrink-0 border-r-0"
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
          className="titlebar-no-drag p-1.5 rounded-md text-[hsl(0,0%,55%)] hover:text-[hsl(0,0%,85%)] hover:bg-[hsl(0,0%,14%)] transition-colors"
        >
          <PanelLeftClose size={16} />
        </button>
        <button
          onClick={handleNewThread}
          title="New Chat"
          className="titlebar-no-drag p-1.5 rounded-md text-[hsl(0,0%,55%)] hover:text-[hsl(0,0%,85%)] hover:bg-[hsl(0,0%,14%)] transition-colors"
        >
          <SquarePen size={16} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2 flex flex-col gap-1">
        {currentWorkspace && (
          <div className="mx-1 mb-3 rounded-2xl border border-[hsl(0,0%,12%)] bg-[hsl(0,0%,8%)] px-3 py-3">
            <div className="text-[10px] uppercase tracking-[0.16em] text-[hsl(0,0%,42%)]">Workspace</div>
            <div className="mt-1 truncate text-sm font-medium text-[hsl(0,0%,82%)]">{currentWorkspace.name}</div>
            <div className="mt-1 truncate text-[11px] text-[hsl(0,0%,42%)]">{currentWorkspace.path}</div>
            <button
              onClick={() => void selectWorkspace()}
              className="mt-3 text-[11px] font-medium text-[hsl(45,85%,62%)] hover:text-[hsl(45,85%,70%)]"
            >
              Change folder
            </button>
          </div>
        )}

        {/* Top pinned items (from reference: Automations, Skills etc if needed, here just basic search for now) */}
        <div className="px-1 pb-4">
          <div className="relative">
            <Search
              size={13}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[hsl(0,0%,35%)]"
            />
            <input
              type="text"
              placeholder="Search..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className={cn(
                'w-full pl-7 pr-2 py-1.5 rounded-md text-xs',
                'bg-[hsl(var(--sidebar-hover))] border-transparent focus:border-[hsl(0,0%,20%)]',
                'text-[hsl(0,0%,70%)] placeholder:text-[hsl(0,0%,30%)]',
                'focus:outline-none transition-colors border',
              )}
            />
          </div>
        </div>

        {/* Section header */}
        <div className="px-2 pb-1 flex flex-col gap-0.5">
          <span className="text-[10px] font-medium text-[hsl(0,0%,45%)] uppercase tracking-wider mb-1">
            Threads
          </span>
        </div>

        {/* Thread list */}
        {filtered.length === 0 && (
          <div className="text-xs text-[hsl(0,0%,30%)] text-center mt-8 px-4">
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
            onClick={() => selectThread(thread.id)}
            workspaceName={getThreadWorkspace(thread.id)?.name ?? null}
          />
        ))}
      </div>

      {/* Bottom settings area */}
      <div className="p-3 shrink-0 flex items-center justify-between">
        <button className="flex items-center gap-2 text-xs font-medium text-[hsl(0,0%,60%)] hover:text-[hsl(0,0%,90%)] transition-colors">
          <Settings size={14} />
          Settings
        </button>
        <button className="text-[10px] font-medium px-2 py-1 rounded bg-[hsl(0,0%,15%)] text-[hsl(0,0%,70%)] hover:bg-[hsl(0,0%,20%)] hover:text-white transition-colors">
          Upgrade
        </button>
      </div>

    </div>
  )
}

function ThreadItem({
  thread,
  isActive,
  onClick,
  workspaceName,
}: {
  thread: Thread
  isActive: boolean
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
        className={cn(
          'w-full text-left px-2.5 py-[7px] rounded-lg transition-colors pr-8',
          isActive
            ? 'bg-[hsl(var(--sidebar-active))] text-white'
            : 'text-[hsl(0,0%,65%)] hover:bg-[hsl(var(--sidebar-hover))] hover:text-[hsl(0,0%,85%)]',
        )}
      >
        <div className="flex items-baseline justify-between gap-3">
          <div className="min-w-0">
            <span className={cn("block text-[13px] truncate", isActive ? "font-medium" : "font-normal")}>
              {title}
            </span>
            {workspaceName && (
              <span className="block text-[10px] truncate text-[hsl(0,0%,42%)]">
                {workspaceName}
              </span>
            )}
          </div>
          {time && (
            <span className={cn(
              "text-[10px] shrink-0",
              isActive ? "text-[hsl(0,0%,55%)]" : "text-[hsl(0,0%,40%)]"
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
        className={cn(
          'absolute right-1.5 top-1/2 -translate-y-1/2',
          'p-[3px] rounded opacity-0 group-hover:opacity-100 transition-opacity',
          isActive
            ? 'text-[hsl(0,0%,50%)] hover:text-[hsl(0,55%,65%)] focus:opacity-100 hover:bg-[hsl(0,0%,20%)]'
            : 'text-[hsl(0,0%,40%)] hover:text-[hsl(0,55%,60%)] focus:opacity-100 hover:bg-[hsl(0,0%,16%)]',
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
