import { FolderOpen, LogOut, PanelRightClose, PanelRightOpen, ShieldCheck, ShieldOff, SquarePen, Inbox } from 'lucide-react'
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

  const title = activeThread?.title ?? (activeThread ? 'New thread' : 'Divo')

  return (
    <header
      className="titlebar-drag flex items-center justify-between h-12 px-4 shrink-0 relative bg-background/80 backdrop-blur-md border-b border-border/50"
      style={{ zIndex: 20 }}
    >
      {/* Left: Toggles + Title */}
      <div className="flex items-center gap-4 titlebar-no-drag min-w-0">
        {!sidebarOpen && (
          <div className="flex items-center gap-1">
            <button
              onClick={toggleSidebar}
              title="Open Sidebar"
              className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-all"
            >
              <PanelRightClose size={16} />
            </button>
            <button
              onClick={() => void createThread()}
              title="New Chat"
              className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-all"
            >
              <SquarePen size={16} />
            </button>
          </div>
        )}
        
        <div className="flex items-center gap-2 min-w-0">
          <h2 className="text-[13px] font-bold text-foreground/90 truncate tracking-tight">
            {title}
          </h2>
          {currentWorkspace && (
            <span className="max-w-[180px] truncate rounded-lg border border-border bg-secondary/30 px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60 shadow-sm">
              {currentWorkspace.name}
            </span>
          )}
        </div>

        {departments.length > 1 && (
          <div className="flex items-center rounded-lg border border-border bg-secondary/30 px-1 py-0.5 shadow-sm">
            <select
              value={selectedDepartmentId ?? ''}
              onChange={(event) => setSelectedDepartmentId(event.target.value || null)}
              className="bg-transparent px-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground/60 outline-none"
              title="Department"
            >
              <option value="" disabled>Dept</option>
              {departments.map((department) => (
                <option key={department.id} value={department.id}>
                  {department.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Right: Actions + User */}
      <div className="flex items-center gap-1 titlebar-no-drag">
        <button
          type="button"
          onClick={() => void selectWorkspace()}
          title="Switch Workspace"
          className="flex h-8 items-center gap-2 rounded-lg px-2 text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-all"
        >
          <FolderOpen size={14} />
          <span className="text-[11px] font-bold uppercase tracking-wider">Folder</span>
        </button>

        <button
          type="button"
          onClick={() => setAutoApproveLocalActions(!autoApproveLocalActions)}
          className={cn(
            'flex h-8 items-center gap-2 rounded-lg px-2 transition-all',
            autoApproveLocalActions
              ? 'bg-primary/10 text-primary hover:bg-primary/20'
              : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50',
          )}
          title={autoApproveLocalActions ? 'Auto-approve active' : 'Manual approval mode'}
        >
          {autoApproveLocalActions ? <ShieldCheck size={14} /> : <ShieldOff size={14} />}
          <span className="text-[11px] font-bold uppercase tracking-wider">{autoApproveLocalActions ? 'Auto' : 'Ask'}</span>
        </button>

        <div className="w-px h-4 bg-border/50 mx-1" />

        <button
          type="button"
          onClick={toggleEditor}
          className={cn(
            'flex h-8 items-center gap-2 rounded-lg px-2 transition-all',
            editorOpen ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50',
          )}
          title={editorOpen ? 'Close Editor' : 'Open Editor'}
        >
          {editorOpen ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
          <span className="text-[11px] font-bold uppercase tracking-wider">Editor</span>
        </button>

        {session && (
          <div className="flex items-center gap-2 ml-2 pl-2 border-l border-border/50">
            <span className="text-[11px] font-medium text-muted-foreground/50 max-w-[120px] truncate">
              {session.name ?? session.email}
            </span>
            <button
              type="button"
              onClick={logout}
              title="Sign out"
              className="p-1.5 rounded-lg text-muted-foreground hover:text-red-500 hover:bg-red-500/10 transition-all"
            >
              <LogOut size={14} />
            </button>
          </div>
        )}
      </div>
    </header>
  )
}
