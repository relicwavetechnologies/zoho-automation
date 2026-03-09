import { LogOut, PanelRightClose, SquarePen } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useChat } from '../context/ChatContext'
import { cn } from '../lib/utils'

interface HeaderProps {
  sidebarOpen: boolean
  toggleSidebar: () => void
}

export function Header({ sidebarOpen, toggleSidebar }: HeaderProps): JSX.Element {
  const { session, logout } = useAuth()
  const { activeThread, isStreaming, createThread } = useChat()

  const title = activeThread?.title ?? (activeThread ? 'New thread' : 'Cursorr')

  return (
    <div
      className="titlebar-drag flex items-center justify-between h-12 px-4 shrink-0 relative"
      style={{
        background: 'hsl(var(--header-bg) / 0.85)',
        boxShadow: '0 4px 12px -2px hsl(0 0% 0% / 0.3)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        zIndex: 20,
      }}
    >
      {/* Left: Optional toggles (when sidebar closed) + thread title */}
      <div className="flex items-center gap-3 titlebar-no-drag min-w-0">
        {!sidebarOpen && (
          <div className="flex items-center gap-1 mr-1">
            <button
              onClick={toggleSidebar}
              title="Open Sidebar"
              className="p-1.5 rounded-md text-[hsl(0,0%,55%)] hover:text-[hsl(0,0%,85%)] hover:bg-[hsl(0,0%,14%)] transition-colors"
            >
              <PanelRightClose size={16} />
            </button>
            <button
              onClick={() => createThread()}
              title="New Chat"
              className="p-1.5 rounded-md text-[hsl(0,0%,55%)] hover:text-[hsl(0,0%,85%)] hover:bg-[hsl(0,0%,14%)] transition-colors"
            >
              <SquarePen size={16} />
            </button>
          </div>
        )}
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
