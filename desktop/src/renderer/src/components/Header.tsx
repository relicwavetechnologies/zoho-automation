import { FolderOpen, LogOut, PanelRightClose, SquarePen } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useChat } from '../context/ChatContext'
import { useWorkspace } from '../context/WorkspaceContext'
import { cn } from '../lib/utils'

interface HeaderProps {
  sidebarOpen: boolean
  toggleSidebar: () => void
}

export function Header({ sidebarOpen, toggleSidebar }: HeaderProps): JSX.Element {
  const { session, logout } = useAuth()
  const { activeThread, createThread } = useChat()
  const { currentWorkspace, selectWorkspace } = useWorkspace()

  const title = activeThread?.title ?? (activeThread ? 'New thread' : 'Cursorr')

  return (
    <div
      className="titlebar-drag flex items-center justify-between h-12 px-4 shrink-0 relative"
      style={{
        background: 'hsl(var(--header-bg))',
        boxShadow: `
          0 4px 20px 2px hsl(0 0% 0% / 0.8),
          0 8px 40px 4px hsl(0 0% 0% / 0.5),
          0 16px 60px 8px hsl(0 0% 0% / 0.25)
        `,
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
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
        {currentWorkspace && (
          <span className="max-w-[260px] truncate rounded-full border border-[hsl(0,0%,14%)] bg-[hsl(0,0%,10%)] px-2.5 py-1 text-[11px] text-[hsl(0,0%,52%)]">
            {currentWorkspace.name}
          </span>
        )}

      </div>

      {/* Right: user + actions */}
      <div className="flex items-center gap-2 titlebar-no-drag">
        <button
          onClick={() => void selectWorkspace()}
          title="Switch workspace folder"
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 transition-colors',
            'text-[hsl(0,0%,45%)] hover:text-[hsl(0,0%,78%)] hover:bg-[hsl(0,0%,12%)]',
          )}
        >
          <FolderOpen size={14} />
          <span className="text-xs">Folder</span>
        </button>
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
