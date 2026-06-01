import { create } from 'zustand';
import { listWorkspaces, upsertWorkspace } from '@/lib/api';
import { STORAGE_KEYS } from '@/lib/config';
import { pickFolder } from '@/lib/tauri';
import type { DesktopWorkspace } from '@/lib/api';

export interface Workspace {
  id: string;
  path: string;
  name: string;
  addedAt: string;
  lastOpenedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Special id for the "Home" pseudo-repository — chats with no workspace.
 * Used by the sidebar's collapse state and the active selector.
 */
export const HOME_WORKSPACE_ID = 'home' as const;

interface WorkspaceState {
  workspaces: Workspace[];
  /** Active workspace id used as context when sending a new chat. `null` = Home. */
  activeWorkspaceId: string | null;
  /** Which sidebar groups are expanded (workspace.id or HOME_WORKSPACE_ID). */
  openGroupIds: string[];

  hydrate: () => void;
  hydrateRemote: (token: string) => Promise<void>;
  mergeRemote: (workspaces: DesktopWorkspace[]) => void;
  addByPath: (path: string) => Workspace;
  upsertByPathRemote: (token: string, path: string, name?: string) => Promise<Workspace | null>;
  pickAndAdd: () => Promise<Workspace | null>;
  remove: (id: string) => void;
  setActive: (id: string | null) => void;
  toggleGroup: (id: string) => void;
  isGroupOpen: (id: string) => boolean;
  clear: () => void;
}

function nameFromPath(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.split('/').pop() || path;
}

function makeId(path: string): string {
  return btoa(path).replace(/=+$/, '');
}

function buildWorkspace(path: string): Workspace {
  const normalizedPath = normalizePath(path);
  return {
    id: makeId(normalizedPath),
    path: normalizedPath,
    name: nameFromPath(normalizedPath),
    addedAt: new Date().toISOString(),
  };
}

function normalizePath(path: string): string {
  return path.trim().replace(/\/+$/, '');
}

function fromRemote(workspace: DesktopWorkspace): Workspace {
  return {
    id: workspace.id,
    path: normalizePath(workspace.path),
    name: workspace.name,
    addedAt: workspace.createdAt ?? new Date().toISOString(),
    lastOpenedAt: workspace.lastOpenedAt ?? null,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  };
}

interface PersistedShape {
  workspaces?: Workspace[];
  activeWorkspaceId?: string | null;
  openGroupIds?: string[];
}

function persist(state: {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  openGroupIds: string[];
}) {
  const payload: PersistedShape = {
    workspaces: state.workspaces,
    activeWorkspaceId: state.activeWorkspaceId,
    openGroupIds: state.openGroupIds,
  };
  localStorage.setItem(STORAGE_KEYS.workspace, JSON.stringify(payload));
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaces: [],
  activeWorkspaceId: null,
  openGroupIds: [HOME_WORKSPACE_ID],

  hydrate: () => {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.workspace);
      if (!raw) return;
      const parsed = JSON.parse(raw) as PersistedShape;
      const workspaces = parsed.workspaces ?? [];
      set({
        workspaces,
        activeWorkspaceId: parsed.activeWorkspaceId ?? null,
        openGroupIds: parsed.openGroupIds ?? [HOME_WORKSPACE_ID, ...workspaces.map((w) => w.id)],
      });
    } catch {
      // ignore corrupt storage
    }
  },

  hydrateRemote: async (token) => {
    const result = await listWorkspaces(token);
    if (result.success && result.data) {
      get().mergeRemote(result.data);
    }
  },

  mergeRemote: (remote) => {
    if (remote.length === 0) return;
    const current = get();
    // Deduplicate by id before processing — callers may pass the same workspace
    // multiple times (e.g. loadThreads sends one entry per thread).
    const seen = new Set<string>();
    const remoteWorkspaces = remote.reduce<Workspace[]>((acc, w) => {
      const converted = fromRemote(w);
      if (!seen.has(converted.id)) {
        seen.add(converted.id);
        acc.push(converted);
      }
      return acc;
    }, []);
    for (const workspace of remoteWorkspaces) {
      const local = current.workspaces.find(
        (item) => item.id === workspace.id || normalizePath(item.path) === workspace.path,
      );
      if (local?.addedAt && !workspace.createdAt) workspace.addedAt = local.addedAt;
    }

    const remotePaths = new Set(remoteWorkspaces.map((workspace) => workspace.path));
    const localOnly = current.workspaces.filter((workspace) => !remotePaths.has(normalizePath(workspace.path)));
    const workspaces = [...remoteWorkspaces, ...localOnly];
    const activeWorkspace = current.activeWorkspaceId
      ? current.workspaces.find((workspace) => workspace.id === current.activeWorkspaceId)
      : null;
    const activeWorkspaceId = activeWorkspace
      ? (remoteWorkspaces.find((workspace) => workspace.path === normalizePath(activeWorkspace.path))?.id ?? current.activeWorkspaceId)
      : current.activeWorkspaceId;
    const openGroupIds = Array.from(new Set([
      ...current.openGroupIds
        .map((id) => {
          const workspace = current.workspaces.find((item) => item.id === id);
          if (!workspace) return id;
          return remoteWorkspaces.find((item) => item.path === normalizePath(workspace.path))?.id ?? id;
        }),
      ...remoteWorkspaces.map((workspace) => workspace.id),
    ]));
    const next = { workspaces, activeWorkspaceId, openGroupIds };
    persist(next);
    set(next);
  },

  addByPath: (path: string) => {
    const normalizedPath = normalizePath(path);
    const existing = get().workspaces.find((w) => normalizePath(w.path) === normalizedPath);
    if (existing) {
      const next = { ...get(), activeWorkspaceId: existing.id };
      persist(next);
      set({ activeWorkspaceId: existing.id });
      return existing;
    }
    const ws = buildWorkspace(normalizedPath);
    const workspaces = [ws, ...get().workspaces];
    const openGroupIds = Array.from(new Set([ws.id, ...get().openGroupIds]));
    const next = { workspaces, activeWorkspaceId: ws.id, openGroupIds };
    persist(next);
    set(next);
    return ws;
  },

  upsertByPathRemote: async (token, path, name) => {
    const normalizedPath = normalizePath(path);
    if (!normalizedPath) return null;
    const result = await upsertWorkspace(token, { path: normalizedPath, name });
    if (!result.success || !result.data) return null;
    get().mergeRemote([result.data]);
    return get().workspaces.find((workspace) => workspace.id === result.data?.id) ?? null;
  },

  pickAndAdd: async () => {
    const path = await pickFolder();
    if (!path) return null;
    return get().addByPath(path);
  },

  remove: (id: string) => {
    const workspaces = get().workspaces.filter((w) => w.id !== id);
    const activeWorkspaceId =
      get().activeWorkspaceId === id ? (workspaces[0]?.id ?? null) : get().activeWorkspaceId;
    const openGroupIds = get().openGroupIds.filter((g) => g !== id);
    const next = { workspaces, activeWorkspaceId, openGroupIds };
    persist(next);
    set(next);
  },

  setActive: (id) => {
    const next = { ...get(), activeWorkspaceId: id };
    persist(next);
    set({ activeWorkspaceId: id });
  },

  toggleGroup: (id) => {
    const open = get().openGroupIds;
    const openGroupIds = open.includes(id) ? open.filter((g) => g !== id) : [...open, id];
    const next = { ...get(), openGroupIds };
    persist(next);
    set({ openGroupIds });
  },

  isGroupOpen: (id) => get().openGroupIds.includes(id),

  clear: () => {
    localStorage.removeItem(STORAGE_KEYS.workspace);
    set({ workspaces: [], activeWorkspaceId: null, openGroupIds: [HOME_WORKSPACE_ID] });
  },
}));

/** Selector for the currently active workspace (back-compat helper). */
export function useActiveWorkspace(): Workspace | null {
  return useWorkspaceStore(
    (s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId) ?? null,
  );
}
