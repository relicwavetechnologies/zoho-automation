import { LogOut, MoreHorizontal } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useChat } from '../context/ChatContext'
import { cn } from '../lib/utils'

export function Header(): JSX.Element {
  const { session, logout } = useAuth()
  const { activeThread, isStreaming } = useChat()

  const title = activeThread?.title ?? (activeThread ? 'New thread' : 'Cursorr')

  return (
    <div
      className="titlebar-drag flex items-center justify-between h-12 px-4 border-b shrink-0"
      style={{
        background: 'hsl(var(--header-bg))',
        borderColor: 'hsl(var(--border))',
      }}
    >
      {/* Left: thread title + status */}
      <div className="flex items-center gap-3 titlebar-no-drag min-w-0">
        <h2 className="text-sm font-medium text-[hsl(0,0%,82%)] truncate">
          {title}
        </h2>
        {isStreaming && (
          <span className="shrink-0 flex items-center gap-1.5 text-[10px] text-[hsl(142,60%,50%)] uppercase tracking-wider font-medium">
            <span className="h-1.5 w-1.5 rounded-full bg-[hsl(142,60%,50%)] animate-pulse" />
            streaming
          </span>
        )}
      </div>

      {/* Right: user + actions */}
      <div className="flex items-center gap-2 titlebar-no-drag">
        {session && (
          <>
            <span className="text-xs text-[hsl(0,0%,40%)]">
              {session.name ?? session.email}
            </span>
            <button
              onClick={logout}
              title="Sign out"
              className={cn(
                'p-1.5 rounded-md transition-colors',
                'text-[hsl(0,0%,40%)] hover:text-[hsl(0,0%,70%)] hover:bg-[hsl(0,0%,12%)]',
              )}
            >
              <LogOut size={14} />
            </button>
          </>
        )}
      </div>
    </div>
  )
}
