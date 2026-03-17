import { FolderOpen, LogOut, PanelRightClose, PanelRightOpen, ShieldCheck, ShieldOff, SquarePen } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useChat } from '../context/ChatContext'
import { useWorkspace } from '../context/WorkspaceContext'
import { cn } from '../lib/utils'

interface HeaderProps {
  sidebarOpen: boolean
  toggleSidebar: () => void
  editorOpen: boolean
  toggleEditor: () => void
}

export function Header({ sidebarOpen, toggleSidebar, editorOpen, toggleEditor }: HeaderProps): JSX.Element {
  const { session, departments, selectedDepartmentId, setSelectedDepartmentId, logout } = useAuth()
  const { activeThread, createThread, autoApproveLocalActions, setAutoApproveLocalActions } = useChat()
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
        {departments.length > 1 && (
          <span className="inline-flex items-center rounded-full border border-[hsl(0,0%,14%)] bg-[hsl(0,0%,10%)] px-1.5 py-1">
            <select
              value={selectedDepartmentId ?? ''}
              onChange={(event) => setSelectedDepartmentId(event.target.value || null)}
              className="bg-transparent px-1 text-[11px] text-[hsl(0,0%,68%)] outline-none"
              title="Department"
            >
              <option value="" disabled>Select department</option>
              {departments.map((department) => (
                <option key={department.id} value={department.id}>
                  {department.name}
                </option>
              ))}
            </select>
          </span>
        )}

      </div>

      {/* Right: user + actions */}
      <div className="flex items-center gap-2 titlebar-no-drag">
        <button
          type="button"
          onClick={() => void selectWorkspace()}
          title="Switch workspace folder"
          className={cn(
            'titlebar-no-drag inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 transition-colors',
            'text-[hsl(0,0%,45%)] hover:text-[hsl(0,0%,78%)] hover:bg-[hsl(0,0%,12%)]',
          )}
        >
          <FolderOpen size={14} />
          <span className="text-xs">Folder</span>
        </button>
        <button
          type="button"
          onClick={() => setAutoApproveLocalActions(!autoApproveLocalActions)}
          title={autoApproveLocalActions ? 'Disable auto-approve for agent local actions' : 'Enable auto-approve for agent local actions'}
          className={cn(
            'titlebar-no-drag inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 transition-colors',
            autoApproveLocalActions
              ? 'text-[hsl(46,90%,66%)] hover:text-[hsl(46,95%,74%)] hover:bg-[hsl(45,50%,14%)]'
              : 'text-[hsl(0,0%,45%)] hover:text-[hsl(0,0%,78%)] hover:bg-[hsl(0,0%,12%)]',
          )}
        >
          {autoApproveLocalActions ? <ShieldCheck size={14} /> : <ShieldOff size={14} />}
          <span className="text-xs">{autoApproveLocalActions ? 'Auto-allow' : 'Ask first'}</span>
        </button>
        <button
          type="button"
          onClick={toggleEditor}
          title={editorOpen ? 'Hide editor' : 'Open editor'}
          className={cn(
            'titlebar-no-drag inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 transition-colors',
            'text-[hsl(0,0%,45%)] hover:text-[hsl(0,0%,78%)] hover:bg-[hsl(0,0%,12%)]',
          )}
        >
          {editorOpen ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
          <span className="text-xs">{editorOpen ? 'Hide editor' : 'Editor'}</span>
        </button>
        {session && (
          <>
            <span className="text-xs text-[hsl(0,0%,40%)]">
              {session.name ?? session.email}
            </span>
            <button
              type="button"
              onClick={logout}
              title="Sign out"
              className={cn(
                'titlebar-no-drag cursor-pointer rounded-md p-1.5 transition-colors',
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
