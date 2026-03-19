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
      className="titlebar-drag glass-panel flex items-center justify-between h-14 px-4 shrink-0 relative border-b-0"
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
              className="glass-button p-1.5 rounded-xl text-muted-foreground hover:text-foreground hover:bg-white/[0.09] transition-colors"
            >
              <PanelRightClose size={16} />
            </button>
            <button
              onClick={() => createThread()}
              title="New Chat"
              className="glass-button p-1.5 rounded-xl text-muted-foreground hover:text-foreground hover:bg-white/[0.09] transition-colors"
            >
              <SquarePen size={16} />
            </button>
          </div>
        )}
        <h2 className="text-sm font-medium text-foreground/90 truncate">
          {title}
        </h2>
        {currentWorkspace && (
          <span className="glass-chip max-w-[260px] truncate rounded-full px-2.5 py-1 text-[11px] text-white/70">
            {currentWorkspace.name}
          </span>
        )}
        {departments.length > 1 && (
          <span className="glass-chip inline-flex items-center rounded-full px-1.5 py-1">
            <select
              value={selectedDepartmentId ?? ''}
              onChange={(event) => setSelectedDepartmentId(event.target.value || null)}
              className="bg-transparent px-1 text-[11px] text-white/70 outline-none"
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
            'titlebar-no-drag glass-button inline-flex cursor-pointer items-center gap-1.5 rounded-xl px-2.5 py-2 transition-colors',
            'text-muted-foreground/70 hover:text-foreground/90 hover:bg-white/[0.08]',
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
            'titlebar-no-drag inline-flex cursor-pointer items-center gap-1.5 rounded-xl px-2.5 py-2 transition-colors',
            autoApproveLocalActions
            ? 'border border-sky-300/12 bg-sky-400/8 text-sky-100/85 hover:bg-sky-400/12'
            : 'glass-button text-muted-foreground/70 hover:text-foreground/90 hover:bg-white/[0.08]',
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
            'titlebar-no-drag glass-button inline-flex cursor-pointer items-center gap-1.5 rounded-xl px-2.5 py-2 transition-colors',
            'text-muted-foreground/70 hover:text-foreground/90 hover:bg-white/[0.08]',
          )}
        >
          {editorOpen ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
          <span className="text-xs">{editorOpen ? 'Hide editor' : 'Editor'}</span>
        </button>
        {session && (
          <>
            <span className="glass-chip rounded-full px-3 py-1 text-xs text-white/62">
              {session.name ?? session.email}
            </span>
            <button
              type="button"
              onClick={logout}
              title="Sign out"
              className={cn(
                'titlebar-no-drag glass-button cursor-pointer rounded-xl p-2 transition-colors',
                'text-muted-foreground/60 hover:text-foreground/90 hover:bg-white/[0.08]',
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
