import { FolderOpen, History, ArrowRight } from 'lucide-react'
import { useWorkspace } from '../context/WorkspaceContext'
import { cn } from '../lib/utils'

export function WorkspaceGate(): JSX.Element {
  const { recentWorkspaces, selectWorkspace, setCurrentWorkspace } = useWorkspace()

  return (
    <div className="flex h-full items-center justify-center px-6" style={{ background: 'hsl(var(--background))' }}>
      <div className="w-full max-w-2xl rounded-[28px] border border-[hsl(0,0%,12%)] bg-[linear-gradient(180deg,hsl(0,0%,8%),hsl(0,0%,6%))] p-8 shadow-[0_32px_120px_rgba(0,0,0,0.45)]">
        <div className="mb-8 flex items-start justify-between gap-6">
          <div>
            <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-2xl border border-[hsl(0,0%,16%)] bg-[hsl(0,0%,10%)]">
              <FolderOpen size={22} className="text-[hsl(45,85%,62%)]" />
            </div>
            <h1 className="text-2xl font-semibold tracking-[-0.02em] text-[hsl(0,0%,92%)]">
              Open a folder to start
            </h1>
            <p className="mt-2 max-w-xl text-sm leading-6 text-[hsl(0,0%,56%)]">
              In this v0, every conversation is scoped to a workspace folder. Pick a folder first, then create or view the threads bound to it.
            </p>
          </div>
        </div>

        <button
          onClick={() => void selectWorkspace()}
          className={cn(
            'inline-flex items-center gap-2 rounded-2xl border px-4 py-3 text-sm font-medium transition-colors',
            'border-[hsl(45,88%,48%)] bg-[hsl(45,88%,56%)] text-[hsl(0,0%,8%)]',
            'hover:bg-[hsl(45,88%,52%)]',
          )}
        >
          <FolderOpen size={16} />
          Open Folder
        </button>

        {recentWorkspaces.length > 0 && (
          <div className="mt-8">
            <div className="mb-3 flex items-center gap-2 text-[11px] uppercase tracking-[0.16em] text-[hsl(0,0%,42%)]">
              <History size={12} />
              Recent Folders
            </div>
            <div className="grid gap-2">
              {recentWorkspaces.map((workspace) => (
                <button
                  key={workspace.id}
                  onClick={() => setCurrentWorkspace(workspace.id)}
                  className="flex items-center justify-between rounded-2xl border border-[hsl(0,0%,12%)] bg-[hsl(0,0%,8%)] px-4 py-3 text-left transition-colors hover:border-[hsl(0,0%,18%)] hover:bg-[hsl(0,0%,10%)]"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-[hsl(0,0%,84%)]">{workspace.name}</div>
                    <div className="truncate text-xs text-[hsl(0,0%,42%)]">{workspace.path}</div>
                  </div>
                  <ArrowRight size={15} className="shrink-0 text-[hsl(0,0%,36%)]" />
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
