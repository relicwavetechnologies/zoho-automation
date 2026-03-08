import { useEffect, useRef, useState } from 'react'
import { Plus, Search, Trash2 } from 'lucide-react'
import { cn } from '../lib/utils'
import { useChat } from '../context/ChatContext'
import type { Thread } from '../types'

export function Sidebar(): JSX.Element {
  const { threads, activeThread, loadThreads, selectThread, createThread } = useChat()
  const [filter, setFilter] = useState('')
  const loadedRef = useRef(false)

  useEffect(() => {
    if (!loadedRef.current) {
      loadedRef.current = true
      loadThreads()
    }
  }, [loadThreads])

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
      className="flex flex-col h-full border-r"
      style={{
        width: 260,
        minWidth: 260,
        background: 'hsl(var(--sidebar-bg))',
        borderColor: 'hsl(var(--sidebar-border))',
      }}
    >
      {/* Titlebar drag region */}
      <div className="titlebar-drag h-12 flex items-end px-4 pb-1.5 shrink-0">
        <span className="text-xs font-medium text-[hsl(0,0%,40%)] uppercase tracking-wider titlebar-no-drag">
          Threads
        </span>
      </div>

      {/* New thread + search */}
      <div className="px-3 pt-2 pb-1 flex flex-col gap-1.5 shrink-0">
        <button
          onClick={handleNewThread}
          className={cn(
            'w-full flex items-center gap-2 px-3 py-1.5 rounded-md text-sm',
            'text-[hsl(0,0%,55%)] hover:text-[hsl(0,0%,80%)]',
            'hover:bg-[hsl(0,0%,12%)] transition-colors',
          )}
        >
          <Plus size={14} />
          <span>New thread</span>
        </button>

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
              'w-full pl-7 pr-2 py-1 rounded-md text-xs',
              'bg-[hsl(0,0%,8%)] border border-[hsl(0,0%,14%)]',
              'text-[hsl(0,0%,70%)] placeholder:text-[hsl(0,0%,30%)]',
              'focus:outline-none focus:border-[hsl(0,0%,25%)]',
              'titlebar-no-drag',
            )}
          />
        </div>
      </div>

      {/* Thread list */}
      <div className="flex-1 overflow-y-auto px-2 py-1">
        {filtered.length === 0 && (
          <div className="text-xs text-[hsl(0,0%,30%)] text-center mt-8 px-4">
            {threads.length === 0
              ? 'No threads yet. Start a new conversation.'
              : 'No matching threads.'}
          </div>
        )}
        {filtered.map((thread) => (
          <ThreadItem
            key={thread.id}
            thread={thread}
            isActive={activeThread?.id === thread.id}
            onClick={() => selectThread(thread.id)}
          />
        ))}
      </div>
    </div>
  )
}

function ThreadItem({
  thread,
  isActive,
  onClick,
}: {
  thread: Thread
  isActive: boolean
  onClick: () => void
}): JSX.Element {
  const { deleteThread } = useChat()
  const title = thread.title ?? 'New thread'
  const time = thread.lastMessageAt
    ? formatRelativeTime(new Date(thread.lastMessageAt))
    : ''

  const handleDelete = async (e: React.MouseEvent): Promise<void> => {
    e.stopPropagation()
    if (!window.confirm(`Delete "${title}"?`)) return
    await deleteThread(thread.id)
  }

  return (
    <div className="relative group mb-0.5">
      <button
        onClick={onClick}
        className={cn(
          'w-full text-left px-3 py-2 rounded-md transition-colors pr-8',
          isActive
            ? 'bg-[hsl(0,0%,14%)] text-[hsl(0,0%,88%)]'
            : 'text-[hsl(0,0%,55%)] hover:bg-[hsl(0,0%,10%)] hover:text-[hsl(0,0%,75%)]',
        )}
      >
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-sm truncate font-medium">{title}</span>
          {time && (
            <span className="text-[10px] text-[hsl(0,0%,35%)] shrink-0">{time}</span>
          )}
        </div>
      </button>

      {/* Delete button — appears on hover */}
      <button
        onClick={handleDelete}
        title="Delete thread"
        className={cn(
          'absolute right-1.5 top-1/2 -translate-y-1/2',
          'p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity',
          'text-[hsl(0,0%,35%)] hover:text-[hsl(0,55%,55%)] hover:bg-[hsl(0,0%,14%)]',
        )}
      >
        <Trash2 size={12} />
      </button>
    </div>
  )
}

function formatRelativeTime(date: Date): string {
  const now = Date.now()
  const diff = now - date.getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days}d`
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
