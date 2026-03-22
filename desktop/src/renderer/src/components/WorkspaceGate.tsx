import { FolderOpen, History, ArrowRight } from "lucide-react";
import { useWorkspace } from "../context/WorkspaceContext";
import { cn } from "../lib/utils";

export function WorkspaceGate(): JSX.Element {
  const { recentWorkspaces, selectWorkspace, setCurrentWorkspace } =
    useWorkspace();

  return (
    <div className="flex-1 flex flex-col items-center justify-center px-6 h-full bg-background selection:bg-primary/30">
      <div className="w-full max-w-2xl flex flex-col">
        <div className="mb-8 flex items-start justify-between gap-6">
          <div>
            <div className="mb-6 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-secondary/20 border border-border/50 shadow-sm">
              <FolderOpen size={22} className="text-primary/80" />
            </div>
            <h1 className="text-3xl font-medium tracking-[-0.03em] text-foreground/90 leading-none">
              Open a folder to start
            </h1>
            <p className="mt-4 max-w-xl text-[14px] leading-relaxed text-muted-foreground/80">
              Every conversation is scoped to a workspace folder. Pick a folder
              first, then create or view the threads bound to it.
            </p>
          </div>
        </div>

        <div>
          <button
            onClick={() => void selectWorkspace()}
            className="group inline-flex items-center gap-2.5 rounded-xl bg-primary text-primary-foreground px-5 py-2.5 text-[13px] font-semibold transition-all hover:opacity-90 shadow-sm"
          >
            <FolderOpen size={16} />
            Open Folder
          </button>
        </div>

        {recentWorkspaces.length > 0 && (
          <div className="mt-12 animate-in fade-in duration-700">
            <div className="mb-4 flex items-center gap-2 text-[10px] uppercase tracking-[0.2em] font-bold text-muted-foreground/60">
              <History size={12} />
              Recent Folders
            </div>
            <div className="grid gap-2">
              {recentWorkspaces.map((workspace) => (
                <button
                  key={workspace.id}
                  onClick={() => setCurrentWorkspace(workspace.id)}
                  className="group flex items-center justify-between rounded-xl border border-border/50 bg-secondary/10 px-4 py-3 text-left transition-all hover:border-border hover:bg-secondary/30 shadow-sm"
                >
                  <div className="min-w-0 flex flex-col gap-1">
                    <div className="truncate text-[14px] font-medium text-foreground/80 group-hover:text-foreground transition-colors">
                      {workspace.name}
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground/60">
                      {workspace.path}
                    </div>
                  </div>
                  <ArrowRight
                    size={15}
                    className="shrink-0 text-muted-foreground/40 group-hover:text-primary/70 transition-colors -translate-x-1 group-hover:translate-x-0"
                  />
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
