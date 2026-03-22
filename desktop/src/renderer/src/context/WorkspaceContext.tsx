import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { WorkspaceFolder } from "../types";

interface WorkspaceState {
  currentWorkspace: WorkspaceFolder | null;
  recentWorkspaces: WorkspaceFolder[];
  hasWorkspace: boolean;
  selectWorkspace: () => Promise<WorkspaceFolder | null>;
  setCurrentWorkspace: (workspaceId: string) => void;
  bindThreadToCurrentWorkspace: (threadId: string) => void;
  unbindThread: (threadId: string) => void;
  isThreadInCurrentWorkspace: (threadId: string) => boolean;
  getThreadWorkspace: (threadId: string) => WorkspaceFolder | null;
}

const CURRENT_WORKSPACE_KEY = "divo_desktop_workspace_current";
const RECENT_WORKSPACES_KEY = "divo_desktop_workspace_recent";
const THREAD_WORKSPACE_KEY = "divo_desktop_workspace_threads";

const WorkspaceContext = createContext<WorkspaceState | null>(null);

const readJson = <T,>(key: string, fallback: T): T => {
  const raw = localStorage.getItem(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

export function WorkspaceProvider({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  const [currentWorkspaceId, setCurrentWorkspaceId] = useState<string | null>(
    () => localStorage.getItem(CURRENT_WORKSPACE_KEY),
  );
  const [recentWorkspaces, setRecentWorkspaces] = useState<WorkspaceFolder[]>(
    () => readJson<WorkspaceFolder[]>(RECENT_WORKSPACES_KEY, []),
  );
  const [threadWorkspaceMap, setThreadWorkspaceMap] = useState<
    Record<string, string>
  >(() => readJson<Record<string, string>>(THREAD_WORKSPACE_KEY, {}));

  useEffect(() => {
    localStorage.setItem(
      RECENT_WORKSPACES_KEY,
      JSON.stringify(recentWorkspaces),
    );
  }, [recentWorkspaces]);

  useEffect(() => {
    if (currentWorkspaceId) {
      localStorage.setItem(CURRENT_WORKSPACE_KEY, currentWorkspaceId);
    } else {
      localStorage.removeItem(CURRENT_WORKSPACE_KEY);
    }
  }, [currentWorkspaceId]);

  useEffect(() => {
    localStorage.setItem(
      THREAD_WORKSPACE_KEY,
      JSON.stringify(threadWorkspaceMap),
    );
  }, [threadWorkspaceMap]);

  const currentWorkspace = useMemo(
    () =>
      recentWorkspaces.find(
        (workspace) => workspace.id === currentWorkspaceId,
      ) ?? null,
    [currentWorkspaceId, recentWorkspaces],
  );

  const selectWorkspace =
    useCallback(async (): Promise<WorkspaceFolder | null> => {
      const result = await window.desktopAPI.workspace.select();
      if (result.canceled || !result.data) return null;

      const selected = result.data;
      setRecentWorkspaces((prev) => {
        const rest = prev.filter((workspace) => workspace.id !== selected.id);
        return [selected, ...rest].slice(0, 8);
      });
      setCurrentWorkspaceId(selected.id);
      return selected;
    }, []);

  const setCurrentWorkspace = useCallback((workspaceId: string) => {
    setCurrentWorkspaceId(workspaceId);
  }, []);

  const bindThreadToCurrentWorkspace = useCallback(
    (threadId: string) => {
      if (!currentWorkspace) return;
      setThreadWorkspaceMap((prev) => ({
        ...prev,
        [threadId]: currentWorkspace.id,
      }));
    },
    [currentWorkspace],
  );

  const unbindThread = useCallback((threadId: string) => {
    setThreadWorkspaceMap((prev) => {
      if (!(threadId in prev)) return prev;
      const next = { ...prev };
      delete next[threadId];
      return next;
    });
  }, []);

  const getThreadWorkspace = useCallback(
    (threadId: string): WorkspaceFolder | null => {
      const workspaceId = threadWorkspaceMap[threadId];
      if (!workspaceId) return null;
      return (
        recentWorkspaces.find((workspace) => workspace.id === workspaceId) ??
        null
      );
    },
    [recentWorkspaces, threadWorkspaceMap],
  );

  const isThreadInCurrentWorkspace = useCallback(
    (threadId: string): boolean => {
      if (!currentWorkspace) return false;
      return threadWorkspaceMap[threadId] === currentWorkspace.id;
    },
    [currentWorkspace, threadWorkspaceMap],
  );

  return (
    <WorkspaceContext.Provider
      value={{
        currentWorkspace,
        recentWorkspaces,
        hasWorkspace: Boolean(currentWorkspace),
        selectWorkspace,
        setCurrentWorkspace,
        bindThreadToCurrentWorkspace,
        unbindThread,
        isThreadInCurrentWorkspace,
        getThreadWorkspace,
      }}
    >
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace(): WorkspaceState {
  const ctx = useContext(WorkspaceContext);
  if (!ctx)
    throw new Error("useWorkspace must be used within WorkspaceProvider");
  return ctx;
}
