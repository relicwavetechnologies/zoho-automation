import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Sparkles,
  Workflow,
  Blocks,
  Folder,
  FolderOpen,
  Home,
  ChevronDown,
  ChevronRight,
  Plus,
  Settings,
  Trash2,
  LogOut,
  RefreshCw,
} from 'lucide-react';
import {
  Sidebar as ShadSidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuAction,
} from '@/components/ui/sidebar';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useChatStore } from '@/store/chat';
import { useAuthStore } from '@/store/auth';
import { HOME_WORKSPACE_ID, useWorkspaceStore } from '@/store/workspace';
import type { Thread } from '@/types/chat';

export function Sidebar() {
  const { session, signOut, startLarkSignIn, status } = useAuthStore();
  const {
    workspaces,
    activeWorkspaceId,
    openGroupIds,
    pickAndAdd,
    remove,
    setActive,
    toggleGroup,
  } = useWorkspaceStore();
  const { threads, activeThreadId, selectThread, removeThread, isStreaming } =
    useChatStore();

  const [profileOpen, setProfileOpen] = useState(false);
  const profileRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!profileOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!profileRef.current?.contains(e.target as Node)) setProfileOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setProfileOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onEsc);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onEsc);
    };
  }, [profileOpen]);

  // Group threads by workspaceId (null or unknown → Home)
  const grouped = useMemo(() => {
    const map = new Map<string, Thread[]>();
    map.set(HOME_WORKSPACE_ID, []);
    for (const ws of workspaces) map.set(ws.id, []);
    for (const t of threads) {
      const matchingWorkspace = t.workspacePath
        ? workspaces.find((workspace) => workspace.path === t.workspacePath)
        : null;
      const key = t.workspaceId && map.has(t.workspaceId)
        ? t.workspaceId
        : matchingWorkspace?.id ?? HOME_WORKSPACE_ID;
      map.get(key)!.push(t);
    }
    return map;
  }, [threads, workspaces]);

  const handlePickThread = (thread: Thread) => {
    const matchingWorkspace = thread.workspacePath
      ? workspaces.find((workspace) => workspace.path === thread.workspacePath)
      : null;
    setActive(thread.workspaceId ?? matchingWorkspace?.id ?? null);
    selectThread(thread.id);
  };

  const handleNewAgent = () => {
    // Clear active thread → renders centered EmptyState composer.
    // The thread is only created on first send (in Composer.submit).
    selectThread(null);
  };

  const handleAddRepo = async () => {
    setProfileOpen(false);
    await pickAndAdd();
  };

  const handleReconnect = async () => {
    setProfileOpen(false);
    await startLarkSignIn();
  };

  const handleSignOut = async () => {
    setProfileOpen(false);
    await signOut();
  };

  const userInitial = (session?.user?.name ?? 'U').slice(0, 1).toUpperCase();
  const userName = session?.user?.name ?? 'User';
  const userSub = session?.user?.role ?? session?.user?.email ?? '';

  return (
    <ShadSidebar
      collapsible="none"
      className="h-full w-[252px] border-r border-border-subtle bg-sidebar"
    >
      {/* Drag region for window movement; reserves traffic-light space */}
      <SidebarHeader className="drag-region gap-0 pt-10" />

      <SidebarContent className="gap-0">
        {/* Pinned nav */}
        <SidebarGroup className="px-2 pb-2 pt-0">
          <SidebarMenu className="gap-0.5">
            <NavRow
              icon={<Sparkles className="h-3.5 w-3.5" />}
              label="New Agent"
              kbd="⌘N"
              active
              disabled={isStreaming}
              onClick={() => void handleNewAgent()}
            />
            <NavRow icon={<Workflow className="h-3.5 w-3.5" />} label="Automations" />
            <NavRow icon={<Blocks className="h-3.5 w-3.5" />} label="Customize" />
          </SidebarMenu>
        </SidebarGroup>

        {/* Repositories */}
        <SidebarGroup className="px-2 pt-2">
          <SidebarGroupLabel className="group/label flex items-center justify-between px-2 text-[10.5px] uppercase tracking-[0.08em] text-fg-dim">
            <span>Repositories</span>
            <button
              onClick={() => void handleAddRepo()}
              title="Add repository"
              aria-label="Add repository"
              className="opacity-0 transition-opacity hover:text-foreground group-hover/label:opacity-100"
            >
              <Plus className="h-3 w-3" />
            </button>
          </SidebarGroupLabel>

          <SidebarGroupContent className="mt-1 flex flex-col gap-px">
            {/* Home pseudo-repo */}
            <RepoGroup
              icon={<Home className="h-3.5 w-3.5" />}
              label="Home"
              isOpen={openGroupIds.includes(HOME_WORKSPACE_ID)}
              isActive={activeWorkspaceId === null}
              onSelect={() => setActive(null)}
              onToggle={() => toggleGroup(HOME_WORKSPACE_ID)}
              threads={grouped.get(HOME_WORKSPACE_ID) ?? []}
              activeThreadId={activeThreadId}
              onPickThread={handlePickThread}
              onDeleteThread={(id) =>
                session?.token && void removeThread(session.token, id)
              }
              disabled={isStreaming}
            />

            {/* User-added repositories */}
            {workspaces.map((w) => (
              <RepoGroup
                key={w.id}
                icon={
                  openGroupIds.includes(w.id) ? (
                    <FolderOpen className="h-3.5 w-3.5" />
                  ) : (
                    <Folder className="h-3.5 w-3.5" />
                  )
                }
                label={w.name}
                isOpen={openGroupIds.includes(w.id)}
                isActive={activeWorkspaceId === w.id}
                onSelect={() => setActive(w.id)}
                onToggle={() => toggleGroup(w.id)}
                onRemove={() => remove(w.id)}
                threads={grouped.get(w.id) ?? []}
                activeThreadId={activeThreadId}
                onPickThread={handlePickThread}
                onDeleteThread={(id) =>
                  session?.token && void removeThread(session.token, id)
                }
                disabled={isStreaming}
              />
            ))}
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <div ref={profileRef} className="relative">
          {profileOpen ? (
            <div className="absolute bottom-full left-1 right-1 z-50 mb-2 overflow-hidden rounded-xl border border-border bg-popover p-1.5 shadow-2xl shadow-black/40">
              <div className="border-b border-border-subtle px-2.5 py-2">
                <div className="truncate text-xs font-medium text-popover-foreground">
                  {userName}
                </div>
                <div className="truncate text-[10.5px] text-fg-dim">
                  {session?.user?.email ?? session?.user?.role ?? ''}
                </div>
              </div>
              <ProfileMenuButton onClick={handleAddRepo}>
                <FolderOpen className="h-3.5 w-3.5" />
                Add repository…
              </ProfileMenuButton>
              <ProfileMenuButton
                onClick={handleReconnect}
                disabled={status === 'authenticating'}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                {status === 'authenticating' ? 'Opening Lark…' : 'Reconnect Lark'}
              </ProfileMenuButton>
              <ProfileMenuButton destructive onClick={handleSignOut}>
                <LogOut className="h-3.5 w-3.5" />
                Log out
              </ProfileMenuButton>
            </div>
          ) : null}

          <div className="no-drag-region flex items-center gap-2.5 px-1 py-1">
            <button
              type="button"
              onClick={() => setProfileOpen((o) => !o)}
              className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-1 py-1 text-left transition-colors hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              aria-expanded={profileOpen}
              aria-label="Open profile settings"
            >
              <div
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-foreground"
                style={{ background: 'hsl(var(--surface-3))' }}
              >
                {userInitial}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs text-foreground">{userName}</div>
                <div className="truncate text-[10.5px] text-fg-dim">{userSub}</div>
              </div>
            </button>
            <Button
              variant="ghost"
              size="icon-sm"
              title="Settings"
              aria-label="Settings"
              onClick={() => setProfileOpen((o) => !o)}
            >
              <Settings className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </SidebarFooter>
    </ShadSidebar>
  );
}

// ─── Pinned nav row ──────────────────────────────────────────────────────────
interface NavRowProps {
  icon: React.ReactNode;
  label: string;
  kbd?: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}
function NavRow({ icon, label, kbd, active, disabled, onClick }: NavRowProps) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={active}
        disabled={disabled}
        onClick={onClick}
        className="h-7 gap-2.5 text-[12.5px] text-fg-muted data-[active=true]:bg-sidebar-accent data-[active=true]:text-foreground"
      >
        <span className="text-fg-muted">{icon}</span>
        <span className="flex-1">{label}</span>
        {kbd ? <span className="font-mono text-[10px] text-fg-dim">{kbd}</span> : null}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

// ─── Repository group: folder row + collapsible threads ──────────────────────
interface RepoGroupProps {
  icon: React.ReactNode;
  label: string;
  isOpen: boolean;
  isActive: boolean;
  onSelect: () => void;
  onToggle: () => void;
  onRemove?: () => void;
  threads: Thread[];
  activeThreadId: string | null;
  onPickThread: (thread: Thread) => void;
  onDeleteThread: (id: string) => void;
  disabled?: boolean;
}
function RepoGroup({
  icon,
  label,
  isOpen,
  isActive,
  onSelect,
  onToggle,
  onRemove,
  threads,
  activeThreadId,
  onPickThread,
  onDeleteThread,
  disabled,
}: RepoGroupProps) {
  return (
    <div className="group/repo">
      <SidebarMenuItem>
        <SidebarMenuButton
          isActive={isActive}
          disabled={disabled}
          onClick={() => {
            onSelect();
            if (!isOpen) onToggle();
          }}
          onDoubleClick={onToggle}
          className="h-7 gap-2 pl-1.5 pr-2 text-[12.5px] text-fg-muted data-[active=true]:bg-sidebar-accent data-[active=true]:text-foreground"
        >
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            className="flex h-4 w-4 items-center justify-center text-fg-dim hover:text-foreground"
            aria-label={isOpen ? 'Collapse' : 'Expand'}
          >
            {isOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </button>
          <span className="text-fg-muted">{icon}</span>
          <span className="flex-1 truncate">{label}</span>
        </SidebarMenuButton>
        {onRemove ? (
          <SidebarMenuAction
            showOnHover
            onClick={(e) => {
              e.stopPropagation();
              if (window.confirm(`Remove "${label}" from sidebar? (chats are kept under Home)`)) {
                onRemove();
              }
            }}
            title="Remove repository"
            aria-label="Remove repository"
            className="text-fg-dim hover:text-destructive"
          >
            <Trash2 className="h-3 w-3" />
          </SidebarMenuAction>
        ) : null}
      </SidebarMenuItem>

      {isOpen ? (
        <div className="ml-[18px] mt-0.5 flex flex-col gap-px">
          {threads.length === 0 ? (
            <div className="px-3 py-1 text-[11px] text-fg-dim">No chats yet</div>
          ) : (
            threads.map((t) => (
              <ThreadRow
                key={t.id}
                thread={t}
                active={activeThreadId === t.id}
                disabled={disabled}
                onClick={() => onPickThread(t)}
                onDelete={() => onDeleteThread(t.id)}
              />
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

// ─── Thread row inside a repo group ──────────────────────────────────────────
interface ThreadRowProps {
  thread: Thread;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  onDelete: () => void;
}
function ThreadRow({ thread, active, disabled, onClick, onDelete }: ThreadRowProps) {
  const title = thread.title ?? 'New thread';
  return (
    <div className="group/row relative">
      <button
        onClick={onClick}
        disabled={disabled}
        className={cn(
          'flex w-full items-center gap-2 rounded-md px-2 py-1 pr-7 text-left text-[12.5px] transition-colors',
          active
            ? 'bg-sidebar-accent text-foreground'
            : 'text-fg-muted hover:bg-sidebar-accent/60 hover:text-foreground',
          disabled && 'cursor-not-allowed opacity-50',
        )}
      >
        <span
          aria-hidden
          className={cn(
            'h-1 w-1 shrink-0 rounded-full',
            active ? 'bg-foreground' : 'bg-fg-dim',
          )}
        />
        <span className="truncate">{title}</span>
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          if (window.confirm(`Delete "${title}"?`)) onDelete();
        }}
        disabled={disabled}
        title="Delete thread"
        aria-label="Delete thread"
        className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-fg-dim opacity-0 transition-opacity hover:bg-sidebar-accent hover:text-destructive group-hover/row:opacity-100"
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  );
}

// ─── Profile dropdown item ───────────────────────────────────────────────────
function ProfileMenuButton({
  children,
  destructive,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { destructive?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        'mt-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
        destructive
          ? 'text-destructive hover:bg-destructive/10'
          : 'text-popover-foreground hover:bg-surface-hover',
        props.className,
      )}
    >
      {children}
    </button>
  );
}
