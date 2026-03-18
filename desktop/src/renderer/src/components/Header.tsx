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
      className="titlebar-drag flex items-center justify-between h-12 px-4 shrink-0 relative bg-header-bg border-b border-border/40"
      style={{
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
              className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              <PanelRightClose size={16} />
            </button>
            <button
              onClick={() => createThread()}
              title="New Chat"
              className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              <SquarePen size={16} />
            </button>
          </div>
        )}
        <h2 className="text-sm font-medium text-foreground/90 truncate">
          {title}
        </h2>
        {currentWorkspace && (
          <span className="max-w-[260px] truncate rounded-full border border-border bg-muted/30 px-2.5 py-1 text-[11px] text-muted-foreground/80">
            {currentWorkspace.name}
          </span>
        )}
        {departments.length > 1 && (
          <span className="inline-flex items-center rounded-full border border-border bg-muted/30 px-1.5 py-1">
            <select
              value={selectedDepartmentId ?? ''}
              onChange={(event) => setSelectedDepartmentId(event.target.value || null)}
              className="bg-transparent px-1 text-[11px] text-muted-foreground/80 outline-none"
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
            'text-muted-foreground/60 hover:text-foreground/80 hover:bg-muted',
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
              ? 'text-primary hover:text-primary/80 hover:bg-primary/10'
              : 'text-muted-foreground/60 hover:text-foreground/80 hover:bg-muted',
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
            'text-muted-foreground/60 hover:text-foreground/80 hover:bg-muted',
          )}
        >
          {editorOpen ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
          <span className="text-xs">{editorOpen ? 'Hide editor' : 'Editor'}</span>
        </button>
        {session && (
          <>
            <span className="text-xs text-muted-foreground/50">
              {session.name ?? session.email}
            </span>
            <button
              type="button"
              onClick={logout}
              title="Sign out"
              className={cn(
                'titlebar-no-drag cursor-pointer rounded-md p-1.5 transition-colors',
                'text-muted-foreground/50 hover:text-foreground/80 hover:bg-muted',
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
