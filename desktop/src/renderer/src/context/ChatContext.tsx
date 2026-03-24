import {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  useEffect,
  type ReactNode,
} from "react";
import type {
  Thread,
  Message,
  ContentBlock,
  MessageMetadata,
  ExecutionPlan,
  ThreadMessagesPage,
  ThreadMessagePagination,
} from "../types";
import { useAuth } from "./AuthContext";
import { useWorkspace } from "./WorkspaceContext";
import {
  buildAgentActionToolBlock,
  summarizeCommandCompletion,
  summarizeWorkspaceAction,
  type DesktopWorkspaceAction,
  type NonCommandWorkspaceAction,
  type PendingLocalActionState,
  type RunningCommandState,
  type ActionLoopResult,
  type ActionResultPayload,
  type ActionCompletion,
} from "../lib/chat-helpers";
import { logFrontendDebug, logFrontendError } from "../lib/frontend-debug-log";

export type { DesktopWorkspaceAction, ActionResultPayload };

type WorkflowInvocation = {
  workflowId: string;
  workflowName: string;
  overrideText?: string;
};

type QueuedOutboundAttachment = {
  fileAssetId: string;
  cloudinaryUrl: string;
  mimeType: string;
  fileName: string;
};

type QueuedOutboundMessage = {
  id: string;
  threadId: string;
  text: string;
  visibleContent: string;
  createdAt: string;
  mode: "fast" | "high";
  attachedFiles?: QueuedOutboundAttachment[];
  workflowInvocation?: WorkflowInvocation;
};

const isActivityFailure = (input: {
  label?: string;
  resultSummary?: string;
}): boolean => {
  const label = (input.label ?? "").toLowerCase();
  const summary = (input.resultSummary ?? "").toLowerCase();
  return (
    label.includes("failed") ||
    label.includes("error") ||
    summary === "error" ||
    summary.includes("failed") ||
    summary.includes("error:") ||
    summary.includes("not permitted")
  );
};

// ── Context contract ──────────────────────────────────────────────────────────

interface ChatState {
  threads: Thread[];
  activeThread: Thread | null;
  messages: Message[];
  isThreadLoading: boolean;
  isLoadingOlderMessages: boolean;
  hasMoreHistory: boolean;
  isStreaming: boolean;
  isThinking: boolean;
  autoApproveLocalActions: boolean;
  activePlan: ExecutionPlan | null;
  liveBlocks: ContentBlock[];
  pendingLocalAction: PendingLocalActionState | null;
  queuedMessages: QueuedOutboundMessage[];
  error: string | null;
  loadThreads: () => Promise<void>;
  selectThread: (threadId: string) => Promise<void>;
  loadOlderMessages: () => Promise<void>;
  createThread: () => Promise<string | null>;
  deleteThread: (threadId: string) => Promise<void>;
  sendMessage: (
    text: string,
    attachedFiles?: Array<{
      fileAssetId: string;
      cloudinaryUrl: string;
      mimeType: string;
      fileName: string;
    }>,
    mode?: "fast" | "high",
    workflowInvocation?: WorkflowInvocation,
  ) => Promise<void>;
  sendInitialMessage: (
    text: string,
    attachedFiles?: Array<{
      fileAssetId: string;
      cloudinaryUrl: string;
      mimeType: string;
      fileName: string;
    }>,
    mode?: "fast" | "high",
    workflowInvocation?: WorkflowInvocation,
  ) => Promise<void>;
  stopExecution: () => Promise<void>;
  approveCommand: (executionId: string) => Promise<void>;
  rejectCommand: (executionId: string) => Promise<void>;
  killCommand: (executionId: string) => Promise<void>;
  editQueuedMessage: (queuedMessageId: string) => QueuedOutboundMessage | null;
  deleteQueuedMessage: (queuedMessageId: string) => void;
  setAutoApproveLocalActions: (enabled: boolean) => void;
  clearError: () => void;
}

const ChatContext = createContext<ChatState | null>(null);

const INITIAL_THREAD_MESSAGE_LIMIT = 6;
const OLDER_THREAD_MESSAGE_LIMIT = 20;
const AUTO_APPROVE_LOCAL_ACTIONS_KEY = "divo_auto_approve_local_actions";
const MAX_ENRICHED_MESSAGES_PER_THREAD = 20;
const MAX_EPHEMERAL_RUNTIME_CACHE_BYTES = 1_500_000;
const MAX_THREAD_PAGE_CACHE_ENTRIES = 8;

type EphemeralRuntimeMessage = {
  id: string;
  contentBlocks: ContentBlock[];
  approxBytes: number;
};

type EphemeralRuntimeThreadCache = {
  messages: EphemeralRuntimeMessage[];
  totalBytes: number;
  lastAccessedAt: number;
};

type ThreadPageCacheEntry = {
  thread: Thread;
  messages: Message[];
  pagination: ThreadMessagePagination;
  lastAccessedAt: number;
};

const prependDistinctMessages = (
  older: Message[],
  current: Message[],
): Message[] => {
  if (older.length === 0) {
    return current;
  }

  const seen = new Set(current.map((message) => message.id));
  const uniqueOlder = older.filter((message) => !seen.has(message.id));
  return uniqueOlder.length > 0 ? [...uniqueOlder, ...current] : current;
};

// ── Provider ──────────────────────────────────────────────────────────────────

export function ChatProvider({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  const { token, session, selectedDepartmentId, setSelectedDepartmentId } =
    useAuth();
  const {
    currentWorkspace,
    bindThreadToCurrentWorkspace,
    getThreadWorkspace,
    unbindThread,
    isThreadInCurrentWorkspace,
  } = useWorkspace();

  // ── Core state ──
  const [allThreads, setAllThreads] = useState<Thread[]>([]);
  const [activeThread, setActiveThread] = useState<Thread | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [threadPagination, setThreadPagination] =
    useState<ThreadMessagePagination>({
      hasMoreOlder: false,
      nextBeforeMessageId: null,
      limit: INITIAL_THREAD_MESSAGE_LIMIT,
    });
  const [isThreadLoading, setIsThreadLoading] = useState(false);
  const [isLoadingOlderMessages, setIsLoadingOlderMessages] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isThinking, setIsThinking] = useState(false);
  const [autoApproveLocalActions, setAutoApproveLocalActionsState] =
    useState<boolean>(() => {
      if (typeof window === "undefined") return false;
      return (
        window.localStorage.getItem(AUTO_APPROVE_LOCAL_ACTIONS_KEY) === "true"
      );
    });
  const [activePlan, setActivePlan] = useState<ExecutionPlan | null>(null);
  const [liveBlocks, setLiveBlocks] = useState<ContentBlock[]>([]);
  const [pendingLocalAction, setPendingLocalAction] =
    useState<PendingLocalActionState | null>(null);
  const [queuedMessagesByThread, setQueuedMessagesByThread] = useState<
    Record<string, QueuedOutboundMessage[]>
  >({});
  const [error, setError] = useState<string | null>(null);

  // ── Refs for mutable cross-callback access ──
  const activeRequestIdRef = useRef<string | null>(null);
  const activeThreadRef = useRef<Thread | null>(null);
  const activeThreadLoadVersionRef = useRef(0);
  const activePlanRef = useRef<ExecutionPlan | null>(null);
  const activeExecutionIdRef = useRef<string | null>(null);
  const activeExecutionMessageIdRef = useRef<string | null>(null);
  const messagesRef = useRef<Message[]>([]);
  const liveBlocksRef = useRef<ContentBlock[]>([]);
  const ephemeralRuntimeCacheRef = useRef<
    Map<string, EphemeralRuntimeThreadCache>
  >(new Map());
  const threadPageCacheRef = useRef<Map<string, ThreadPageCacheEntry>>(
    new Map(),
  );
  const deletingThreadIdsRef = useRef<Set<string>>(new Set());
  const queuedMessagesByThreadRef = useRef<Record<string, QueuedOutboundMessage[]>>(
    {},
  );
  const flushingQueuedMessageRef = useRef(false);
  const loadThreadsRef = useRef<(() => Promise<void>) | null>(null);
  const pendingLocalActionRef = useRef<PendingLocalActionState | null>(null);
  const runningCommandRef = useRef<RunningCommandState | null>(null);
  const approveCommandRef = useRef<
    ((executionId: string) => Promise<void>) | null
  >(null);
  const cancelRequestedRef = useRef(false);
  const activeModeRef = useRef<"fast" | "high">("high");
  const autoApproveLocalActionsRef = useRef(autoApproveLocalActions);

  useEffect(() => {
    if (!token) {
      void window.desktopAPI.chat.disconnectLivePresence();
      return;
    }
    void window.desktopAPI.chat.updateLivePresence(
      token,
      currentWorkspace
        ? {
            name: currentWorkspace.name,
            path: currentWorkspace.path,
          }
        : null,
    );
  }, [token, currentWorkspace?.name, currentWorkspace?.path]);

  // ── Shared live-block utilities ──
  const appendOutput = useCallback((prev: string, chunk: string): string => {
    const next = prev + chunk;
    const maxChars = 24000;
    return next.length > maxChars ? next.slice(next.length - maxChars) : next;
  }, []);

  const replaceLiveBlocks = useCallback(
    (updater: (prev: ContentBlock[]) => ContentBlock[]) => {
      setLiveBlocks((prev) => {
        const next = updater(prev);
        liveBlocksRef.current = next;
        return next;
      });
    },
    [],
  );

  const estimateContentBlocksBytes = useCallback(
    (blocks: ContentBlock[]): number => {
      try {
        return JSON.stringify(blocks).length;
      } catch {
        return blocks.length * 256;
      }
    },
    [],
  );

  const evictEphemeralRuntimeCacheIfNeeded = useCallback(() => {
    const cache = ephemeralRuntimeCacheRef.current;
    const sumBytes = (): number =>
      Array.from(cache.values()).reduce(
        (total, entry) => total + entry.totalBytes,
        0,
      );

    let totalBytes = sumBytes();
    if (totalBytes <= MAX_EPHEMERAL_RUNTIME_CACHE_BYTES) return;

    const activeThreadId = activeThreadRef.current?.id ?? null;
    const entries = Array.from(cache.entries()).sort(
      (left, right) => left[1].lastAccessedAt - right[1].lastAccessedAt,
    );

    for (const [threadId] of entries) {
      if (threadId === activeThreadId) continue;
      cache.delete(threadId);
      totalBytes = sumBytes();
      if (totalBytes <= MAX_EPHEMERAL_RUNTIME_CACHE_BYTES) return;
    }

    if (!activeThreadId) return;
    const activeEntry = cache.get(activeThreadId);
    if (!activeEntry) return;

    while (
      activeEntry.messages.length > 0 &&
      activeEntry.totalBytes > MAX_EPHEMERAL_RUNTIME_CACHE_BYTES
    ) {
      const removed = activeEntry.messages.shift();
      activeEntry.totalBytes -= removed?.approxBytes ?? 0;
    }

    if (activeEntry.messages.length === 0) {
      cache.delete(activeThreadId);
      return;
    }

    cache.set(activeThreadId, activeEntry);
  }, []);

  const cacheRuntimeBlocks = useCallback(
    (message: Message) => {
      const contentBlocks = message.metadata?.contentBlocks;
      if (!contentBlocks || contentBlocks.length === 0) return;

      const cache = ephemeralRuntimeCacheRef.current;
      const threadId = message.threadId;
      const approxBytes = estimateContentBlocksBytes(contentBlocks);
      const existing = cache.get(threadId) ?? {
        messages: [],
        totalBytes: 0,
        lastAccessedAt: Date.now(),
      };

      const filtered = existing.messages.filter(
        (entry) => entry.id !== message.id,
      );
      const nextMessages = [
        ...filtered,
        { id: message.id, contentBlocks, approxBytes },
      ];
      while (nextMessages.length > MAX_ENRICHED_MESSAGES_PER_THREAD) {
        nextMessages.shift();
      }

      const totalBytes = nextMessages.reduce(
        (total, entry) => total + entry.approxBytes,
        0,
      );
      cache.set(threadId, {
        messages: nextMessages,
        totalBytes,
        lastAccessedAt: Date.now(),
      });
      evictEphemeralRuntimeCacheIfNeeded();
    },
    [estimateContentBlocksBytes, evictEphemeralRuntimeCacheIfNeeded],
  );

  const applyEphemeralRuntimeCache = useCallback(
    (threadId: string, nextMessages: Message[]): Message[] => {
      const entry = ephemeralRuntimeCacheRef.current.get(threadId);
      if (!entry || entry.messages.length === 0) {
        return nextMessages;
      }

      entry.lastAccessedAt = Date.now();
      const contentBlocksById = new Map(
        entry.messages.map((message) => [message.id, message.contentBlocks]),
      );

      return nextMessages.map((message) => {
        const contentBlocks = contentBlocksById.get(message.id);
        if (!contentBlocks || contentBlocks.length === 0) {
          return message;
        }
        return {
          ...message,
          metadata: {
            ...(message.metadata ?? {}),
            contentBlocks,
          },
        };
      });
    },
    [],
  );

  const clearEphemeralRuntimeCacheForThread = useCallback(
    (threadId: string) => {
      ephemeralRuntimeCacheRef.current.delete(threadId);
    },
    [],
  );

  const cacheThreadPage = useCallback(
    (input: {
      thread: Thread;
      messages: Message[];
      pagination: ThreadMessagePagination;
    }) => {
      const cache = threadPageCacheRef.current;
      cache.set(input.thread.id, {
        thread: input.thread,
        messages: input.messages,
        pagination: input.pagination,
        lastAccessedAt: Date.now(),
      });

      if (cache.size <= MAX_THREAD_PAGE_CACHE_ENTRIES) return;

      const oldest = Array.from(cache.entries()).sort(
        (left, right) => left[1].lastAccessedAt - right[1].lastAccessedAt,
      )[0];
      if (oldest) {
        cache.delete(oldest[0]);
      }
    },
    [],
  );

  const getCachedThreadPage = useCallback((threadId: string) => {
    const entry = threadPageCacheRef.current.get(threadId) ?? null;
    if (entry) {
      entry.lastAccessedAt = Date.now();
    }
    return entry;
  }, []);

  const clearCachedThreadPage = useCallback((threadId: string) => {
    threadPageCacheRef.current.delete(threadId);
  }, []);

  const replaceActivePlan = useCallback((plan: ExecutionPlan | null) => {
    activePlanRef.current = plan;
    setActivePlan(plan);
  }, []);

  const replaceActiveExecutionId = useCallback((executionId: string | null) => {
    activeExecutionIdRef.current = executionId;
  }, []);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    queuedMessagesByThreadRef.current = queuedMessagesByThread;
  }, [queuedMessagesByThread]);

  useEffect(() => {
    autoApproveLocalActionsRef.current = autoApproveLocalActions;
    window.localStorage.setItem(
      AUTO_APPROVE_LOCAL_ACTIONS_KEY,
      autoApproveLocalActions ? "true" : "false",
    );
  }, [autoApproveLocalActions]);

  const setAutoApproveLocalActions = useCallback((enabled: boolean) => {
    setAutoApproveLocalActionsState(enabled);
  }, []);

  const resetLiveState = useCallback(() => {
    setLiveBlocks([]);
    liveBlocksRef.current = [];
    setIsStreaming(false);
    setIsThinking(false);
    replaceActivePlan(null);
    replaceActiveExecutionId(null);
    activeExecutionMessageIdRef.current = null;
    activeRequestIdRef.current = null;
    pendingLocalActionRef.current = null;
    setPendingLocalAction(null);
    runningCommandRef.current = null;
  }, [replaceActiveExecutionId, replaceActivePlan]);

  const finishPendingApprovalStream = useCallback(() => {
    setIsStreaming(false);
    setIsThinking(false);
    activeRequestIdRef.current = null;
    runningCommandRef.current = null;
  }, []);

  const resolveContinuationMessageId = useCallback(
    (threadId: string, executionId: string, preferredMessageId?: string | null) => {
      if (preferredMessageId) {
        return preferredMessageId;
      }
      if (activeExecutionMessageIdRef.current) {
        return activeExecutionMessageIdRef.current;
      }

      const pausedMessage = [...messagesRef.current]
        .reverse()
        .find((message) => {
          if (message.role !== "assistant" || message.threadId !== threadId) {
            return false;
          }
          if (message.metadata?.executionId !== executionId) {
            return false;
          }
          return (
            message.metadata.executionState?.state === "waiting_for_approval" &&
            Boolean(message.metadata.desktopPendingAction)
          );
        });

      const resolvedMessageId = pausedMessage?.id ?? null;
      logFrontendDebug("approval.continuation_message.resolve", {
        threadId,
        executionId,
        preferredMessageId: preferredMessageId ?? null,
        activeExecutionMessageId: activeExecutionMessageIdRef.current,
        resolvedMessageId,
      });
      return resolvedMessageId;
    },
    [],
  );

  const restorePendingExecutionFromMessages = useCallback(
    (threadId: string, nextMessages: Message[]) => {
      const supersededExecutionIds = new Set(
        nextMessages.flatMap((message) => {
          const executionId = message.metadata?.executionId;
          if (
            message.role !== "assistant" ||
            message.threadId !== threadId ||
            typeof executionId !== "string"
          ) {
            return [];
          }
          const state = message.metadata?.executionState?.state;
          return state && state !== "waiting_for_approval" ? [executionId] : [];
        }),
      );

      const pausedMessage = [...nextMessages]
        .reverse()
        .find(
          (message) =>
            message.role === "assistant" &&
            message.threadId === threadId &&
            typeof message.metadata?.executionId === "string" &&
            message.metadata.executionState?.state === "waiting_for_approval" &&
            message.metadata.desktopPendingAction &&
            !supersededExecutionIds.has(message.metadata.executionId),
        );

      if (
        !pausedMessage ||
        !pausedMessage.metadata?.desktopPendingAction ||
        !pausedMessage.metadata.executionId
      ) {
        logFrontendDebug("approval.restore.none", {
          threadId,
          messageCount: nextMessages.length,
          supersededExecutionCount: supersededExecutionIds.size,
        });
        activeExecutionMessageIdRef.current = null;
        pendingLocalActionRef.current = null;
        setPendingLocalAction(null);
        return;
      }

      const action = pausedMessage.metadata.desktopPendingAction;
      const pendingAction: PendingLocalActionState | null =
        action.kind === "tool_action" &&
        action.approvalId &&
        action.toolId &&
        action.actionGroup &&
        action.operation &&
        action.title &&
        action.summary
          ? {
              id: pausedMessage.metadata.executionId,
              threadId,
              workspaceName: currentWorkspace?.name ?? "Remote action",
              workspacePath: currentWorkspace?.path ?? "",
              source: "agent",
              action: {
                kind: "tool_action",
                approvalId: action.approvalId,
                toolId: action.toolId,
                actionGroup: action.actionGroup,
                operation: action.operation,
                title: action.title,
                summary: action.summary,
                ...(action.subject ? { subject: action.subject } : {}),
                ...(action.explanation
                  ? { explanation: action.explanation }
                  : {}),
              },
              continuationMessageId: pausedMessage.id,
            }
          : action.kind === "run_command" && action.command
            ? {
                id: pausedMessage.metadata.executionId,
                threadId,
                workspaceName: currentWorkspace?.name ?? "Workspace",
                workspacePath: currentWorkspace?.path ?? "",
                source: "agent",
                action: {
                  kind: "run_command",
                  command: action.command,
                },
                continuationMessageId: pausedMessage.id,
              }
            : action.kind === "write_file" &&
                action.path &&
                action.content !== undefined
              ? {
                  id: pausedMessage.metadata.executionId,
                  threadId,
                  workspaceName: currentWorkspace?.name ?? "Workspace",
                  workspacePath: currentWorkspace?.path ?? "",
                  source: "agent",
                  action: {
                    kind: "write_file",
                    path: action.path,
                    content: action.content,
                  },
                  continuationMessageId: pausedMessage.id,
                }
              : action.kind === "mkdir" && action.path
                ? {
                    id: pausedMessage.metadata.executionId,
                    threadId,
                    workspaceName: currentWorkspace?.name ?? "Workspace",
                    workspacePath: currentWorkspace?.path ?? "",
                    source: "agent",
                    action: {
                      kind: "mkdir",
                      path: action.path,
                    },
                    continuationMessageId: pausedMessage.id,
                  }
                : action.kind === "delete_path" && action.path
                  ? {
                      id: pausedMessage.metadata.executionId,
                      threadId,
                      workspaceName: currentWorkspace?.name ?? "Workspace",
                      workspacePath: currentWorkspace?.path ?? "",
                      source: "agent",
                      action: {
                        kind: "delete_path",
                        path: action.path,
                      },
                      continuationMessageId: pausedMessage.id,
                    }
                  : null;

      activeExecutionMessageIdRef.current = pausedMessage.id;
      replaceActiveExecutionId(pausedMessage.metadata.executionId);
      pendingLocalActionRef.current = pendingAction;
      setPendingLocalAction(pendingAction);
      logFrontendDebug("approval.restore.pending", {
        threadId,
        executionId: pausedMessage.metadata.executionId,
        messageId: pausedMessage.id,
        actionKind: pendingAction?.action.kind ?? null,
      });
    },
    [currentWorkspace?.name, currentWorkspace?.path, replaceActiveExecutionId],
  );

  const upsertAssistantMessage = useCallback(
    (message: Message) => {
      cacheRuntimeBlocks(message);
      setMessages((prev) => {
        const existingIndex = prev.findIndex(
          (entry) => entry.id === message.id,
        );
        if (existingIndex >= 0) {
          const next = [...prev];
          next[existingIndex] = message;
          return next;
        }
        return [...prev, message];
      });
    },
    [cacheRuntimeBlocks],
  );

  const promotePersistedExecutionToLive = useCallback((threadId: string) => {
    const persistedMessageId = activeExecutionMessageIdRef.current;
    if (!persistedMessageId) return;

    setMessages((prev) => {
      const target = prev.find(
        (message) =>
          message.id === persistedMessageId && message.threadId === threadId,
      );
      if (!target) return prev;
      const blocks = target.metadata?.contentBlocks ?? [];
      if (blocks.length > 0) {
        setLiveBlocks(blocks);
        liveBlocksRef.current = blocks;
      }
      return prev.filter((message) => message.id !== persistedMessageId);
    });
  }, []);

  const commitPartialAssistant = useCallback(() => {
    const blocks = liveBlocksRef.current;
    if (blocks.length === 0) return;
    const textContent = blocks
      .filter(
        (block): block is Extract<ContentBlock, { type: "text" }> =>
          block.type === "text",
      )
      .map((block) => block.content)
      .join("");
    setMessages((prev) => [
      ...prev,
      {
        id: `assistant-partial-${Date.now()}`,
        threadId: activeThreadRef.current?.id ?? "",
        role: "assistant",
        content: textContent,
        createdAt: new Date().toISOString(),
        metadata: { contentBlocks: blocks, streaming: false },
      },
    ]);
  }, []);

  // ── Persist a local action summary to the thread ──
  const persistLocalSummary = useCallback(
    async (input: {
      threadId: string;
      content: string;
      metadata?: MessageMetadata;
    }) => {
      if (!token) return;
      try {
        await window.desktopAPI.threads.addMessage(token, input.threadId, {
          role: "assistant",
          content: input.content,
          metadata: input.metadata as Record<string, unknown> | undefined,
        });
      } catch {
        setError("Local action finished, but saving the summary log failed.");
      }
    },
    [token],
  );

  const persistExecutionEvent = useCallback(
    async (input: {
      executionId: string;
      phase:
        | "request"
        | "planning"
        | "tool"
        | "synthesis"
        | "delivery"
        | "error"
        | "control";
      eventType: string;
      actorType: "system" | "planner" | "agent" | "tool" | "model" | "delivery";
      actorKey?: string;
      title: string;
      summary?: string;
      status?: string;
      payload?: Record<string, unknown>;
    }) => {
      if (!token) return;
      try {
        await window.desktopAPI.fetch(
          `/api/desktop/executions/${input.executionId}/events`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(input),
          },
        );
      } catch {
        // non-fatal; runtime should continue even if client-side event mirroring fails
      }
    },
    [token],
  );

  // ── Finalize an agent-driven local action turn ──
  const finalizeLocalBlocks = useCallback(
    async (input: {
      threadId: string;
      summaryContent?: string;
      summaryMetadata?: MessageMetadata;
      appendPersistedMessage?: Message | null;
    }) => {
      const finalizedBlocks = liveBlocksRef.current;

      if (finalizedBlocks.length > 0) {
        setMessages((prev) => [
          ...prev,
          {
            id: `local-action-${Date.now()}`,
            threadId: input.threadId,
            role: "assistant",
            content: "",
            createdAt: new Date().toISOString(),
            metadata: { contentBlocks: finalizedBlocks },
          },
        ]);
      }

      if (input.appendPersistedMessage) {
        setMessages((prev) => [...prev, input.appendPersistedMessage!]);
      }

      if (input.summaryContent) {
        await persistLocalSummary({
          threadId: input.threadId,
          content: input.summaryContent,
          metadata: input.summaryMetadata,
        });
      }

      void loadThreadsRef.current?.();
      resetLiveState();
    },
    [persistLocalSummary, resetLiveState],
  );

  // ── Execute a non-command workspace action ──
  const runWorkspaceAction = useCallback(
    async (input: {
      action: NonCommandWorkspaceAction;
      toolBlockId: string;
      threadId: string;
    }): Promise<ActionCompletion> => {
      if (!currentWorkspace) {
        const failed = summarizeWorkspaceAction(input.action, {
          success: false,
          error: "No workspace selected",
        });
        replaceLiveBlocks((prev) =>
          prev.map((block) =>
            block.type === "tool" && block.id === input.toolBlockId
              ? {
                  ...block,
                  status: "failed",
                  resultSummary: failed.toolResultSummary,
                }
              : block,
          ),
        );
        return failed;
      }

      const result = await window.desktopAPI.workspace.runAction(
        currentWorkspace.path,
        input.action,
      );
      const completion = summarizeWorkspaceAction(input.action, result);

      replaceLiveBlocks((prev) =>
        prev.map((block) =>
          block.type === "tool" && block.id === input.toolBlockId
            ? {
                ...block,
                status: completion.ok ? "done" : "failed",
                resultSummary: completion.toolResultSummary,
              }
            : block,
        ),
      );

      return completion;
    },
    [currentWorkspace, replaceLiveBlocks],
  );

  // ── Run one agentic action loop turn ──
  const runAgentLocalActionTurn = useCallback(
    async (input: {
      threadId: string;
      initialMessage?: string;
      actionResult?: ActionResultPayload;
      continuationMessageId?: string | null;
    }): Promise<void> => {
      if (!token) return;
      if (typeof window.desktopAPI.chat.actStream !== "function") {
        setError(
          "Workspace tools are not loaded in this desktop session. Restart the Electron app to enable file and terminal actions.",
        );
        resetLiveState();
        return;
      }

      const requestId = crypto.randomUUID();
      const executionId = activeExecutionIdRef.current ?? requestId;
      activeRequestIdRef.current = requestId;
      replaceActiveExecutionId(executionId);
      setIsStreaming(true);
      setIsThinking(true);
      replaceLiveBlocks((prev) => {
        const last = prev[prev.length - 1];
        if (last?.type === "thinking") return prev;
        return [...prev, { type: "thinking", text: "" }];
      });
      logFrontendDebug("agent.local_action.turn.start", {
        threadId: input.threadId,
        hasInitialMessage: Boolean(input.initialMessage),
        actionKind: input.actionResult?.kind ?? null,
        executionId,
        requestId,
      });

      try {
        const response = await window.desktopAPI.chat.actStream(
          token,
          input.threadId,
          requestId,
          {
            message: input.initialMessage,
            ...(currentWorkspace
              ? {
                  workspace: {
                    name: currentWorkspace.name,
                    path: currentWorkspace.path,
                  },
                }
              : {}),
            actionResult: input.actionResult,
            ...(activePlanRef.current ? { plan: activePlanRef.current } : {}),
            mode: activeModeRef.current,
            executionId,
            ...(() => {
              const continuationMessageId = resolveContinuationMessageId(
                input.threadId,
                executionId,
                input.continuationMessageId,
              );
              if (!continuationMessageId) {
                return {};
              }
              activeExecutionMessageIdRef.current = continuationMessageId;
              return { continuationMessageId };
            })(),
          },
        );

        if (!response.success)
          throw new Error(response.message || "Desktop action loop failed");
        if (cancelRequestedRef.current) return;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Desktop action loop failed";
        logFrontendError("agent.local_action.turn.failed", err, {
          threadId: input.threadId,
          executionId,
          actionKind: input.actionResult?.kind ?? null,
        });
        setError(message);
        setIsStreaming(false);
        setIsThinking(false);
        if (liveBlocksRef.current.length === 0) {
          resetLiveState();
        }
      }
    },
    [
      currentWorkspace,
      resolveContinuationMessageId,
      replaceActiveExecutionId,
      replaceLiveBlocks,
      resetLiveState,
      token,
    ],
  );

  // ── Finish a terminal command execution ──
  const finishCommandExecution = useCallback(
    async (input: {
      executionId: string;
      status: "done" | "failed";
      exitCode?: number | null;
      signal?: string | null;
      durationMs?: number;
    }) => {
      const runningCommand = runningCommandRef.current;
      if (!runningCommand || runningCommand.id !== input.executionId) return;

      const terminalBlock = liveBlocksRef.current.find(
        (block): block is Extract<ContentBlock, { type: "terminal" }> =>
          block.type === "terminal" && block.id === input.executionId,
      );

      const completion = summarizeCommandCompletion({
        command: runningCommand.command,
        cwd: runningCommand.cwd,
        status: input.status,
        exitCode: input.exitCode,
        signal: input.signal,
        durationMs: input.durationMs,
        stdout: terminalBlock?.stdout,
        stderr: terminalBlock?.stderr,
      });

      runningCommandRef.current = null;
      logFrontendDebug("terminal.command.finished", {
        executionId: input.executionId,
        threadId: runningCommand.threadId,
        status: input.status,
        exitCode: input.exitCode ?? null,
        source: runningCommand.source,
      });

      if (runningCommand.source === "agent") {
        if (cancelRequestedRef.current) return;
        await runAgentLocalActionTurn({
          threadId: runningCommand.threadId,
          actionResult: {
            kind: "run_command",
            ok: completion.ok,
            summary: completion.actionResultSummary,
          },
        });
        return;
      }

      await persistLocalSummary({
        threadId: runningCommand.threadId,
        content: completion.summaryContent,
        metadata: completion.summaryMetadata,
      });
      await finalizeLocalBlocks({ threadId: runningCommand.threadId });
    },
    [
      finalizeLocalBlocks,
      persistLocalSummary,
      replaceActivePlan,
      runAgentLocalActionTurn,
    ],
  );

  // ── SSE stream event subscriber ──
  useEffect(() => {
    const unsubscribe = window.desktopAPI.chat.onStreamEvent(
      ({ requestId, event }) => {
        if (activeRequestIdRef.current !== requestId) return;

        switch (event.type) {
          case "plan":
            replaceActivePlan((event.data as ExecutionPlan | null) ?? null);
            break;
          case "thinking_token": {
            const delta = String(event.data ?? "");
            if (!delta) break;
            replaceLiveBlocks((prev) => {
              const last = prev[prev.length - 1];
              if (last?.type !== "thinking") return prev;
              return [
                ...prev.slice(0, -1),
                {
                  ...last,
                  text:
                    ((last as Extract<ContentBlock, { type: "thinking" }>)
                      .text || "") + delta,
                },
              ];
            });
            break;
          }
          case "thinking":
            setIsThinking(true);
            replaceLiveBlocks((prev) => {
              const last = prev[prev.length - 1];
              if (last?.type === "thinking") return prev;
              return [...prev, { type: "thinking" }];
            });
            break;
          case "activity": {
            const raw = event.data as {
              id: string;
              name: string;
              label: string;
              icon: string;
            };
            setIsThinking(false);
            replaceLiveBlocks((prev) => [
              ...prev,
              {
                type: "tool",
                id: raw.id ?? String(Date.now()),
                name: raw.name ?? "",
                label: raw.label ?? raw.name ?? "Working...",
                icon: raw.icon ?? "zap",
                status: "running",
              },
            ]);
            break;
          }
          case "activity_done": {
            const raw = event.data as {
              id: string;
              label?: string;
              icon?: string;
              name?: string;
              resultSummary?: string;
            };
            const ok = !isActivityFailure(raw);
            replaceLiveBlocks((prev) =>
              prev.map((block) =>
                block.type === "tool" && block.id === raw.id
                  ? {
                      ...block,
                      name: raw.name ?? block.name,
                      label: raw.label ?? block.label,
                      icon: raw.icon ?? block.icon,
                      status: ok ? ("done" as const) : ("failed" as const),
                      resultSummary: raw.resultSummary,
                    }
                  : block,
              ),
            );
            break;
          }
          case "action": {
            const raw = event.data as {
              action?: DesktopWorkspaceAction;
              executionId?: string;
            } | null;
            const action = raw?.action;
            const threadId = activeThreadRef.current?.id;
            if (!action || !threadId) break;
            setIsThinking(false);

            const actionId = raw?.executionId ?? crypto.randomUUID();
            pendingLocalActionRef.current = {
              id: actionId,
              threadId,
              workspaceName: currentWorkspace?.name ?? "Remote action",
              workspacePath: currentWorkspace?.path ?? "",
              action,
              source: "agent",
              continuationMessageId:
                activeExecutionMessageIdRef.current ?? undefined,
            };
            setPendingLocalAction(pendingLocalActionRef.current);
            logFrontendDebug("approval.action.received", {
              threadId,
              executionId: actionId,
              actionKind: action.kind,
              continuationMessageId:
                pendingLocalActionRef.current.continuationMessageId ?? null,
            });
            if (
              autoApproveLocalActionsRef.current &&
              action.kind !== "list_files" &&
              action.kind !== "read_file"
            ) {
              queueMicrotask(() => {
                void approveCommandRef.current?.(actionId);
              });
            }
            break;
          }
          case "text": {
            const chunk = String(event.data ?? "");
            setIsThinking(false);
            replaceLiveBlocks((prev) => {
              const last = prev[prev.length - 1];
              if (last?.type === "text")
                return [
                  ...prev.slice(0, -1),
                  { type: "text", content: last.content + chunk },
                ];
              return [...prev, { type: "text", content: chunk }];
            });
            break;
          }
          case "error":
            if (cancelRequestedRef.current) {
              cancelRequestedRef.current = false;
              resetLiveState();
              break;
            }
            setError(String(event.data ?? "Stream failed. Please try again."));
            resetLiveState();
            break;
          case "done": {
            const raw = event.data as {
              message?: Message;
              actionIssued?: boolean;
              state?: string;
              executionId?: string;
            } | null;
            const persistedMessage = raw?.message;
            if (raw?.actionIssued) {
              if (persistedMessage?.id) {
                activeExecutionMessageIdRef.current = persistedMessage.id;
                if (
                  raw.executionId &&
                  pendingLocalActionRef.current?.id === raw.executionId
                ) {
                  const nextPendingAction = {
                    ...pendingLocalActionRef.current,
                    continuationMessageId: persistedMessage.id,
                  };
                  pendingLocalActionRef.current = nextPendingAction;
                  setPendingLocalAction(nextPendingAction);
                }
              }
              logFrontendDebug("approval.done.awaiting", {
                executionId: raw.executionId ?? null,
                persistedMessageId: persistedMessage?.id ?? null,
                pendingActionKind:
                  pendingLocalActionRef.current?.action.kind ?? null,
              });
            } else if (persistedMessage) {
              const liveBlocks = liveBlocksRef.current;
              upsertAssistantMessage(
                liveBlocks.length > 0
                  ? {
                      ...persistedMessage,
                      metadata: {
                        ...(persistedMessage.metadata ?? {}),
                        contentBlocks: liveBlocks,
                      },
                    }
                  : persistedMessage,
              );
              activeExecutionMessageIdRef.current = null;
            } else {
              setMessages((prev) => {
                const blocks = liveBlocksRef.current;
                const textContent = blocks
                  .filter(
                    (b): b is Extract<ContentBlock, { type: "text" }> =>
                      b.type === "text",
                  )
                  .map((b) => b.content)
                  .join("");
                if (!textContent && blocks.length === 0) return prev;
                return [
                  ...prev,
                  {
                    id: `assistant-${Date.now()}`,
                    threadId: activeThreadRef.current?.id ?? "",
                    role: "assistant",
                    content: textContent,
                    createdAt: new Date().toISOString(),
                    metadata:
                      blocks.length > 0 ? { contentBlocks: blocks } : undefined,
                  },
                ];
              });
              activeExecutionMessageIdRef.current = null;
            }
            void loadThreadsRef.current?.();
            cancelRequestedRef.current = false;
            if (raw?.actionIssued) {
              finishPendingApprovalStream();
            } else {
              resetLiveState();
            }
            break;
          }
          default:
            break;
        }
      },
    );
    return unsubscribe;
  }, [
    currentWorkspace,
    finishPendingApprovalStream,
    replaceActiveExecutionId,
    replaceActivePlan,
    replaceLiveBlocks,
    resetLiveState,
    upsertAssistantMessage,
  ]);

  // ── Terminal event subscriber ──
  useEffect(() => {
    const unsubscribe = window.desktopAPI.terminal.onEvent(
      ({ executionId, event }) => {
        const runningCommand = runningCommandRef.current;
        if (!runningCommand || runningCommand.id !== executionId) return;

        switch (event.type) {
          case "stdout": {
            const chunk = String(event.data ?? "");
            replaceLiveBlocks((prev) =>
              prev.map((block) =>
                block.type === "terminal" && block.id === executionId
                  ? { ...block, stdout: appendOutput(block.stdout, chunk) }
                  : block,
              ),
            );
            void persistExecutionEvent({
              executionId,
              phase: "control",
              eventType: "terminal.stdout",
              actorType: "tool",
              actorKey: "terminal",
              title: "Terminal stdout",
              summary: chunk.slice(0, 1000),
              status: "running",
              payload: { chunk },
            });
            break;
          }
          case "stderr": {
            const chunk = String(event.data ?? "");
            replaceLiveBlocks((prev) =>
              prev.map((block) =>
                block.type === "terminal" && block.id === executionId
                  ? { ...block, stderr: appendOutput(block.stderr, chunk) }
                  : block,
              ),
            );
            void persistExecutionEvent({
              executionId,
              phase: "control",
              eventType: "terminal.stderr",
              actorType: "tool",
              actorKey: "terminal",
              title: "Terminal stderr",
              summary: chunk.slice(0, 1000),
              status: "running",
              payload: { chunk },
            });
            break;
          }
          case "error": {
            const raw = event.data as { message?: string; durationMs?: number };
            replaceLiveBlocks((prev) =>
              prev.map((block) =>
                block.type === "terminal" && block.id === executionId
                  ? {
                      ...block,
                      status: "failed",
                      stderr: appendOutput(
                        block.stderr,
                        `${raw.message ?? "Execution failed"}\n`,
                      ),
                      durationMs: raw.durationMs,
                    }
                  : block,
              ),
            );
            void persistExecutionEvent({
              executionId,
              phase: "control",
              eventType: "terminal.failed",
              actorType: "tool",
              actorKey: "terminal",
              title: "Terminal execution failed",
              summary: raw.message ?? "Execution failed",
              status: "failed",
              payload: { durationMs: raw.durationMs ?? null },
            });
            void finishCommandExecution({
              executionId,
              status: "failed",
              durationMs: raw.durationMs,
            });
            break;
          }
          case "exit": {
            const raw = event.data as {
              exitCode?: number | null;
              signal?: string | null;
              durationMs?: number;
            };
            const terminalStatus: "done" | "failed" =
              raw.exitCode === 0 ? "done" : "failed";
            replaceLiveBlocks((prev) =>
              prev.map((block) =>
                block.type === "terminal" && block.id === executionId
                  ? {
                      ...block,
                      status: terminalStatus,
                      exitCode: raw.exitCode ?? null,
                      signal: raw.signal ?? null,
                      durationMs: raw.durationMs,
                    }
                  : block,
              ),
            );
            void persistExecutionEvent({
              executionId,
              phase: "control",
              eventType:
                terminalStatus === "done"
                  ? "terminal.completed"
                  : "terminal.failed",
              actorType: "tool",
              actorKey: "terminal",
              title:
                terminalStatus === "done"
                  ? "Terminal execution completed"
                  : "Terminal execution failed",
              summary: `Exit code ${raw.exitCode ?? "unknown"}`,
              status: terminalStatus,
              payload: {
                exitCode: raw.exitCode ?? null,
                signal: raw.signal ?? null,
                durationMs: raw.durationMs ?? null,
              },
            });
            void finishCommandExecution({
              executionId,
              status: terminalStatus,
              exitCode: raw.exitCode ?? null,
              signal: raw.signal ?? null,
              durationMs: raw.durationMs,
            });
            break;
          }
          default:
            break;
        }
      },
    );
    return unsubscribe;
  }, [
    appendOutput,
    finishCommandExecution,
    persistExecutionEvent,
    replaceLiveBlocks,
  ]);

  useEffect(() => {
    activeThreadRef.current = activeThread;
  }, [activeThread]);

  useEffect(() => {
    if (!currentWorkspace) {
      setActiveThread(null);
      setMessages([]);
      setThreadPagination({
        hasMoreOlder: false,
        nextBeforeMessageId: null,
        limit: INITIAL_THREAD_MESSAGE_LIMIT,
      });
      setIsThreadLoading(false);
      setIsLoadingOlderMessages(false);
      replaceActivePlan(null);
      return;
    }
    if (
      activeThreadRef.current &&
      !isThreadInCurrentWorkspace(activeThreadRef.current.id)
    ) {
      setActiveThread(null);
      setMessages([]);
      setThreadPagination({
        hasMoreOlder: false,
        nextBeforeMessageId: null,
        limit: INITIAL_THREAD_MESSAGE_LIMIT,
      });
      setIsThreadLoading(false);
      setIsLoadingOlderMessages(false);
      replaceActivePlan(null);
    }
  }, [currentWorkspace, isThreadInCurrentWorkspace, replaceActivePlan]);

  const threads = currentWorkspace
    ? allThreads.filter((thread) => isThreadInCurrentWorkspace(thread.id))
    : [];

  // ── Approval handlers ──
  const approveCommand = useCallback(
    async (executionId: string) => {
      const pendingAction = pendingLocalActionRef.current;
      if (!pendingAction || pendingAction.id !== executionId) return;

      const continuationMessageId =
        pendingAction.source === "agent"
          ? resolveContinuationMessageId(
              pendingAction.threadId,
              executionId,
              pendingAction.continuationMessageId,
            )
          : null;
      if (continuationMessageId) {
        activeExecutionMessageIdRef.current = continuationMessageId;
      }
      logFrontendDebug("approval.command.approve.start", {
        executionId,
        threadId: pendingAction.threadId,
        actionKind: pendingAction.action.kind,
        continuationMessageId,
      });

      pendingLocalActionRef.current = null;
      setPendingLocalAction(null);
      void persistExecutionEvent({
        executionId,
        phase: "control",
        eventType: "control.approved",
        actorType: "system",
        actorKey: pendingAction.action.kind,
        title: `${pendingAction.action.kind} approval approved`,
        summary:
          pendingAction.action.kind === "run_command"
            ? pendingAction.action.command
            : pendingAction.action.kind === "tool_action"
              ? pendingAction.action.summary
              : pendingAction.action.path,
        status: "done",
        payload: { cwd: pendingAction.workspacePath },
      });

      if (pendingAction.action.kind === "tool_action") {
        if (pendingAction.source === "agent") {
          promotePersistedExecutionToLive(pendingAction.threadId);
        }
        const result = await window.desktopAPI.chat.resolveHitlAction(
          token!,
          pendingAction.threadId,
          pendingAction.action.approvalId,
          "confirmed",
        );
        if (!result.success) {
          setError(result.message ?? "Failed to execute approved action");
          return;
        }
        const actionResult = ((
          result.data as { data?: ActionResultPayload } | undefined
        )?.data ?? result.data) as ActionResultPayload | undefined;
        if (!actionResult) {
          setError("Approved action completed but no result was returned");
          return;
        }
        await runAgentLocalActionTurn({
          threadId: pendingAction.threadId,
          actionResult,
          continuationMessageId,
        });
        return;
      }

      if (pendingAction.action.kind === "run_command") {
        const command = pendingAction.action.command;
        if (pendingAction.source === "agent") {
          promotePersistedExecutionToLive(pendingAction.threadId);
        }
        logFrontendDebug("approval.command.approved", {
          executionId,
          threadId: pendingAction.threadId,
          command,
        });
        runningCommandRef.current = {
          id: executionId,
          threadId: pendingAction.threadId,
          workspaceName: pendingAction.workspaceName,
          cwd: pendingAction.workspacePath,
          command,
          source: pendingAction.source,
        };
        replaceLiveBlocks((prev) => [
          ...prev,
          {
            type: "terminal",
            id: executionId,
            command,
            cwd: pendingAction.workspacePath,
            status: "running",
            stdout: "",
            stderr: "",
          },
        ]);
        void persistExecutionEvent({
          executionId,
          phase: "control",
          eventType: "terminal.started",
          actorType: "tool",
          actorKey: "terminal",
          title: "Terminal execution started",
          summary: command,
          status: "running",
          payload: { cwd: pendingAction.workspacePath },
        });
        const result = await window.desktopAPI.terminal.exec(
          executionId,
          command,
          pendingAction.workspacePath,
        );
        if (!result.success) {
          logFrontendError(
            "approval.command.exec_failed",
            result.error ?? "Execution failed",
            {
              executionId,
              threadId: pendingAction.threadId,
            },
          );
          replaceLiveBlocks((prev) =>
            prev.map((block) =>
              block.type === "terminal" && block.id === executionId
                ? {
                    ...block,
                    status: "failed",
                    stderr: appendOutput(
                      block.stderr,
                      `${result.error ?? "Execution failed"}\n`,
                    ),
                  }
                : block,
            ),
          );
          await finishCommandExecution({ executionId, status: "failed" });
        }
        return;
      }

      const toolBlock = buildAgentActionToolBlock(pendingAction.action);
      if (pendingAction.source === "agent") {
        promotePersistedExecutionToLive(pendingAction.threadId);
      }
      replaceLiveBlocks((prev) => [...prev, toolBlock]);
      const completion = await runWorkspaceAction({
        action: pendingAction.action as NonCommandWorkspaceAction,
        toolBlockId: toolBlock.id,
        threadId: pendingAction.threadId,
      });

      if (pendingAction.source === "agent") {
        await runAgentLocalActionTurn({
          threadId: pendingAction.threadId,
          actionResult: {
            kind: pendingAction.action.kind,
            ok: completion.ok,
            summary: completion.actionResultSummary,
          },
          continuationMessageId,
        });
        return;
      }
      await finalizeLocalBlocks({
        threadId: pendingAction.threadId,
        summaryContent: completion.summaryContent,
        summaryMetadata: completion.summaryMetadata,
      });
    },
    [
      appendOutput,
      finalizeLocalBlocks,
      finishCommandExecution,
      persistExecutionEvent,
      promotePersistedExecutionToLive,
      replaceActivePlan,
      replaceLiveBlocks,
      resolveContinuationMessageId,
      runAgentLocalActionTurn,
      runWorkspaceAction,
    ],
  );

  useEffect(() => {
    approveCommandRef.current = approveCommand;
  }, [approveCommand]);

  const rejectCommand = useCallback(
    async (executionId: string) => {
      const pendingAction = pendingLocalActionRef.current;
      if (!pendingAction || pendingAction.id !== executionId) return;

      const continuationMessageId =
        pendingAction.source === "agent"
          ? resolveContinuationMessageId(
              pendingAction.threadId,
              executionId,
              pendingAction.continuationMessageId,
            )
          : null;
      if (continuationMessageId) {
        activeExecutionMessageIdRef.current = continuationMessageId;
      }
      logFrontendDebug("approval.command.reject.start", {
        executionId,
        threadId: pendingAction.threadId,
        actionKind: pendingAction.action.kind,
        continuationMessageId,
      });

      pendingLocalActionRef.current = null;
      setPendingLocalAction(null);
      logFrontendDebug("approval.command.rejected", {
        executionId,
        threadId: pendingAction.threadId,
        actionKind: pendingAction.action.kind,
      });
      void persistExecutionEvent({
        executionId,
        phase: "control",
        eventType: "control.rejected",
        actorType: "system",
        actorKey: pendingAction.action.kind,
        title: `${pendingAction.action.kind} approval rejected`,
        summary:
          pendingAction.action.kind === "run_command"
            ? pendingAction.action.command
            : pendingAction.action.kind === "tool_action"
              ? pendingAction.action.summary
              : pendingAction.action.path,
        status: "failed",
        payload: { cwd: pendingAction.workspacePath },
      });

      if (pendingAction.action.kind === "tool_action") {
        if (pendingAction.source === "agent") {
          promotePersistedExecutionToLive(pendingAction.threadId);
        }
        const result = await window.desktopAPI.chat.resolveHitlAction(
          token!,
          pendingAction.threadId,
          pendingAction.action.approvalId,
          "cancelled",
        );
        if (!result.success) {
          setError(result.message ?? "Failed to reject action");
          return;
        }
        const actionResult = ((
          result.data as { data?: ActionResultPayload } | undefined
        )?.data ?? result.data) as ActionResultPayload | undefined;
        if (!actionResult) {
          setError("Rejected action completed but no result was returned");
          return;
        }
        await runAgentLocalActionTurn({
          threadId: pendingAction.threadId,
          actionResult,
          continuationMessageId,
        });
        return;
      }

      if (pendingAction.action.kind === "run_command") {
        const completion = summarizeCommandCompletion({
          command: pendingAction.action.command,
          cwd: pendingAction.workspacePath,
          status: "rejected",
        });
        if (pendingAction.source === "agent") {
          promotePersistedExecutionToLive(pendingAction.threadId);
          await runAgentLocalActionTurn({
            threadId: pendingAction.threadId,
            actionResult: {
              kind: "run_command",
              ok: false,
              summary: completion.actionResultSummary,
            },
            continuationMessageId,
          });
          return;
        }
        await finalizeLocalBlocks({
          threadId: pendingAction.threadId,
          summaryContent: completion.summaryContent,
          summaryMetadata: completion.summaryMetadata,
        });
        return;
      }

      const fileAction = pendingAction.action as Extract<
        DesktopWorkspaceAction,
        { kind: "write_file" | "mkdir" | "delete_path" }
      >;
      const summaryContent = `Rejected ${fileAction.kind.replace("_", " ")} for \`${fileAction.path}\`.`;
      const summaryMetadata: MessageMetadata = {
        localFileSummary: {
          kind: fileAction.kind,
          path: fileAction.path,
          status: "rejected",
        },
      };
      if (pendingAction.source === "agent") {
        promotePersistedExecutionToLive(pendingAction.threadId);
        await runAgentLocalActionTurn({
          threadId: pendingAction.threadId,
          actionResult: {
            kind: fileAction.kind,
            ok: false,
            summary: `User rejected ${fileAction.kind} for ${fileAction.path}`,
          },
          continuationMessageId,
        });
        return;
      }
      await finalizeLocalBlocks({
        threadId: pendingAction.threadId,
        summaryContent,
        summaryMetadata,
      });
    },
    [
      finalizeLocalBlocks,
      persistExecutionEvent,
      promotePersistedExecutionToLive,
      resolveContinuationMessageId,
      runAgentLocalActionTurn,
      token,
    ],
  );

  const killCommand = useCallback(async (executionId: string) => {
    const runningCommand = runningCommandRef.current;
    if (!runningCommand || runningCommand.id !== executionId) return;
    const result = await window.desktopAPI.terminal.kill(executionId);
    if (!result.success) setError(result.error ?? "Failed to stop command");
  }, []);

  // ── Thread management ──
  const loadThreads = useCallback(async () => {
    if (!token) return;
    try {
      const res = await window.desktopAPI.threads.list(token);
      if (res.success && res.data) {
        const nextThreads = res.data as Thread[];
        if (currentWorkspace) {
          nextThreads.forEach((thread) => {
            if (!getThreadWorkspace(thread.id)) {
              bindThreadToCurrentWorkspace(thread.id);
            }
          });
        }
        setAllThreads(nextThreads);
      }
    } catch {
      setError("Failed to load threads");
    }
  }, [token, currentWorkspace, getThreadWorkspace, bindThreadToCurrentWorkspace]);

  useEffect(() => {
    loadThreadsRef.current = loadThreads;
  }, [loadThreads]);

  const selectThread = useCallback(
    async (threadId: string) => {
      if (
        !token ||
        !currentWorkspace ||
        !isThreadInCurrentWorkspace(threadId) ||
        isStreaming
      )
        return;
      const requestVersion = activeThreadLoadVersionRef.current + 1;
      activeThreadLoadVersionRef.current = requestVersion;
      const threadPreview =
        allThreads.find((thread) => thread.id === threadId) ?? null;
      const cachedPage = getCachedThreadPage(threadId);
      setActiveThread(threadPreview);
      setMessages(
        cachedPage ? applyEphemeralRuntimeCache(threadId, cachedPage.messages) : [],
      );
      pendingLocalActionRef.current = null;
      setPendingLocalAction(null);
      activeExecutionMessageIdRef.current = null;
      setThreadPagination(
        cachedPage?.pagination ?? {
          hasMoreOlder: false,
          nextBeforeMessageId: null,
          limit: INITIAL_THREAD_MESSAGE_LIMIT,
        },
      );
      setIsThreadLoading(!cachedPage);
      setIsLoadingOlderMessages(false);
      try {
        const res = await window.desktopAPI.threads.get(token, threadId, {
          limit: INITIAL_THREAD_MESSAGE_LIMIT,
        });
        if (res.success && res.data) {
          const data = res.data as ThreadMessagesPage;
          if (activeThreadLoadVersionRef.current !== requestVersion) return;
          setActiveThread(data.thread);
          if (data.thread.departmentId) {
            setSelectedDepartmentId(data.thread.departmentId);
          }
          const hydratedMessages = applyEphemeralRuntimeCache(
            data.thread.id,
            data.messages,
          );
          setMessages(hydratedMessages);
          setThreadPagination(data.pagination);
          cacheThreadPage({
            thread: data.thread,
            messages: data.messages,
            pagination: data.pagination,
          });
          replaceActivePlan(null);
          restorePendingExecutionFromMessages(data.thread.id, data.messages);
          setError(null);
        }
      } catch {
        setError("Failed to load thread");
      } finally {
        if (activeThreadLoadVersionRef.current === requestVersion) {
          setIsThreadLoading(false);
        }
      }
    },
    [
      allThreads,
      token,
      currentWorkspace,
      isThreadInCurrentWorkspace,
      isStreaming,
      applyEphemeralRuntimeCache,
      cacheThreadPage,
      getCachedThreadPage,
      replaceActivePlan,
      restorePendingExecutionFromMessages,
      setSelectedDepartmentId,
    ],
  );

  const loadOlderMessages = useCallback(async () => {
    const threadId = activeThreadRef.current?.id;
    if (
      !token ||
      !threadId ||
      isLoadingOlderMessages ||
      !threadPagination.hasMoreOlder
    )
      return;

    const beforeMessageId =
      threadPagination.nextBeforeMessageId ?? messages[0]?.id;
    if (!beforeMessageId) return;

    const requestVersion = activeThreadLoadVersionRef.current;
    setIsLoadingOlderMessages(true);

    try {
      const res = await window.desktopAPI.threads.get(token, threadId, {
        limit: OLDER_THREAD_MESSAGE_LIMIT,
        beforeMessageId,
      });

      if (!res.success || !res.data) {
        throw new Error("Failed to load older messages");
      }

      if (
        activeThreadLoadVersionRef.current !== requestVersion ||
        activeThreadRef.current?.id !== threadId
      ) {
        return;
      }

      const data = res.data as ThreadMessagesPage;
      setMessages((prev) => {
        const mergedMessages = prependDistinctMessages(data.messages, prev);
        const activeThread = activeThreadRef.current;
        if (activeThread) {
          cacheThreadPage({
            thread: activeThread,
            messages: mergedMessages,
            pagination: data.pagination,
          });
        }
        return applyEphemeralRuntimeCache(threadId, mergedMessages);
      });
      setThreadPagination(data.pagination);
    } catch {
      setError("Failed to load older messages");
    } finally {
      if (
        activeThreadLoadVersionRef.current === requestVersion &&
        activeThreadRef.current?.id === threadId
      ) {
        setIsLoadingOlderMessages(false);
      }
    }
  }, [
    applyEphemeralRuntimeCache,
    cacheThreadPage,
    isLoadingOlderMessages,
    messages,
    threadPagination.hasMoreOlder,
    threadPagination.nextBeforeMessageId,
    token,
  ]);

  const createThread = useCallback(async (): Promise<string | null> => {
    if (!token || !currentWorkspace || isStreaming) return null;
    if ((session?.departments?.length ?? 0) > 1 && !selectedDepartmentId) {
      setError("Select a department before starting a new chat.");
      return null;
    }
    try {
      const res = await window.desktopAPI.threads.create(
        token,
        selectedDepartmentId
          ? { departmentId: selectedDepartmentId }
          : undefined,
      );
      if (res.success && res.data) {
        const newThread = res.data as Thread;
        bindThreadToCurrentWorkspace(newThread.id);
        clearCachedThreadPage(newThread.id);
        setAllThreads((prev) => [newThread, ...prev]);
        setActiveThread(newThread);
        setMessages([]);
        setThreadPagination({
          hasMoreOlder: false,
          nextBeforeMessageId: null,
          limit: INITIAL_THREAD_MESSAGE_LIMIT,
        });
        setIsThreadLoading(false);
        setIsLoadingOlderMessages(false);
        replaceActivePlan(null);
        return newThread.id;
      }
      return null;
    } catch {
      setError("Failed to create thread");
      return null;
    }
  }, [
    token,
    currentWorkspace,
    isStreaming,
    bindThreadToCurrentWorkspace,
    clearCachedThreadPage,
    replaceActivePlan,
    selectedDepartmentId,
    session?.departments?.length,
  ]);

  const sendMessage = useCallback(
    async (
      text: string,
      attachedFiles?: Array<{
        fileAssetId: string;
        cloudinaryUrl: string;
        mimeType: string;
        fileName: string;
      }>,
      mode: "fast" | "high" = "high",
      workflowInvocation?: WorkflowInvocation,
    ) => {
      const targetThread = activeThreadRef.current;
      if (!token || !currentWorkspace || !targetThread) return;
      if (deletingThreadIdsRef.current.has(targetThread.id)) {
        setError("This chat is being deleted. Start or select another chat.");
        return;
      }
      const trimmedText = text.trim();
      cancelRequestedRef.current = false;
      activeModeRef.current = mode;

      if (
        !trimmedText &&
        (!attachedFiles || attachedFiles.length === 0) &&
        !workflowInvocation
      )
        return;

      const visibleUserText =
        trimmedText ||
        (workflowInvocation
          ? workflowInvocation.overrideText?.trim()
            ? `Run workflow "${workflowInvocation.workflowName}" with a one-time override.`
            : `Run saved workflow "${workflowInvocation.workflowName}".`
          : "");

      if (isStreaming) {
        queueOutboundMessage({
          threadId: targetThread.id,
          text: trimmedText,
          visibleContent: visibleUserText,
          attachedFiles,
          mode,
          workflowInvocation,
        });
        setError(null);
        return;
      }

      const runMatch = trimmedText.match(/^\/run\s+([\s\S]+)$/i);
      if (runMatch) {
        const command = runMatch[1].trim();
        try {
          await window.desktopAPI.threads.addMessage(token, targetThread.id, {
            role: "user",
            content: trimmedText,
          });
        } catch {
          setError("Failed to save the command request.");
        }
        const executionId = crypto.randomUUID();
        const nextPendingAction = {
          id: executionId,
          threadId: targetThread.id,
          workspaceName: currentWorkspace.name,
          workspacePath: currentWorkspace.path,
          action: { kind: "run_command", command } as const,
          source: "manual" as const,
        };
        pendingLocalActionRef.current = nextPendingAction;
        setPendingLocalAction(nextPendingAction);
        setIsStreaming(false);
        setIsThinking(false);
        replaceActiveExecutionId(null);
        return;
      }

      await dispatchOutgoingMessage({
        threadId: targetThread.id,
        text: trimmedText,
        visibleContent: visibleUserText,
        attachedFiles,
        mode,
        workflowInvocation,
      });
    },
    [
      token,
      currentWorkspace,
      isStreaming,
      replaceActiveExecutionId,
      replaceActivePlan,
      runAgentLocalActionTurn,
    ],
  );

  const sendInitialMessage = useCallback(
    async (
      text: string,
      attachedFiles?: Array<{
        fileAssetId: string;
        cloudinaryUrl: string;
        mimeType: string;
        fileName: string;
      }>,
      mode: "fast" | "high" = "high",
      workflowInvocation?: WorkflowInvocation,
    ) => {
      if (!token || !currentWorkspace) return;
      if ((session?.departments?.length ?? 0) > 1 && !selectedDepartmentId) {
        setError("Select a department before starting a new chat.");
        return;
      }
      const trimmedText = text.trim();
      cancelRequestedRef.current = false;
      activeModeRef.current = mode;

      if (
        !trimmedText &&
        (!attachedFiles || attachedFiles.length === 0) &&
        !workflowInvocation
      )
        return;

      const visibleUserText =
        trimmedText ||
        (workflowInvocation
          ? workflowInvocation.overrideText?.trim()
            ? `Run workflow "${workflowInvocation.workflowName}" with a one-time override.`
            : `Run saved workflow "${workflowInvocation.workflowName}".`
          : "");

      if (isStreaming && activeThreadRef.current) {
        queueOutboundMessage({
          threadId: activeThreadRef.current.id,
          text: trimmedText,
          visibleContent: visibleUserText,
          attachedFiles,
          mode,
          workflowInvocation,
        });
        setError(null);
        return;
      }

      try {
        const res = await window.desktopAPI.threads.create(
          token,
          selectedDepartmentId
            ? { departmentId: selectedDepartmentId }
            : undefined,
        );
        if (res.success && res.data) {
          const newThread = res.data as Thread;
          bindThreadToCurrentWorkspace(newThread.id);
          clearCachedThreadPage(newThread.id);
          setAllThreads((prev) => [newThread, ...prev]);
          setActiveThread(newThread);
          setMessages([]);
          setThreadPagination({
            hasMoreOlder: false,
            nextBeforeMessageId: null,
            limit: INITIAL_THREAD_MESSAGE_LIMIT,
          });
          setIsThreadLoading(false);
          setIsLoadingOlderMessages(false);
          replaceActivePlan(null);
          activeExecutionMessageIdRef.current = null;

          const userMsg: Message = {
            id: `temp-${Date.now()}`,
            threadId: newThread.id,
            role: "user",
            content: visibleUserText,
            metadata:
              attachedFiles && attachedFiles.length > 0
                ? { attachedFiles }
                : undefined,
            createdAt: new Date().toISOString(),
          };

          setMessages([userMsg]);
          setIsStreaming(true);
          setIsThinking(false);
          setError(null);

          const requestId = crypto.randomUUID();
          activeRequestIdRef.current = requestId;

          if (typeof window.desktopAPI.chat.sendMessageStream !== "function") {
            console.error(
              "[CRITICAL] window.desktopAPI.chat.sendMessageStream is not defined. The desktop app needs a full restart to load new preload scripts.",
            );
            setError(
              "Application architecture changed. Please restart the desktop app to send messages.",
            );
            setIsStreaming(false);
            setMessages([]);
            return;
          }

          const streamResult = await window.desktopAPI.chat.sendMessageStream({
            token,
            requestId,
            threadId: newThread.id,
            message: trimmedText,
            attachedFiles,
            mode,
            companyId: currentWorkspace.id,
            workspace: {
              name: currentWorkspace.name,
              path: currentWorkspace.path,
            },
            workflowInvocation,
          });

          if (!streamResult.success) {
            setError(streamResult.error ?? "Failed to send message");
            setIsStreaming(false);
            setMessages([]); // Rollback optimistic update
            return;
          }
        }
      } catch (error) {
        console.error("Failed to create thread and send message:", error);
        setError("Failed to create thread and send message");
      }
    },
    [
      token,
      currentWorkspace,
      isStreaming,
      bindThreadToCurrentWorkspace,
      clearCachedThreadPage,
      replaceActivePlan,
      selectedDepartmentId,
      session?.departments?.length,
    ],
  );

  const stopExecution = useCallback(async () => {
    cancelRequestedRef.current = true;

    const requestId = activeRequestIdRef.current;
    if (requestId) {
      await window.desktopAPI.chat.stopStream(requestId).catch(() => undefined);
    }

    const runningCommand = runningCommandRef.current;
    if (runningCommand) {
      await window.desktopAPI.terminal
        .kill(runningCommand.id)
        .catch(() => undefined);
    }

    commitPartialAssistant();
    resetLiveState();
  }, [commitPartialAssistant, resetLiveState]);

  const upsertQueuedMessagesForThread = useCallback(
    (threadId: string, updater: (current: QueuedOutboundMessage[]) => QueuedOutboundMessage[]) => {
      setQueuedMessagesByThread((prev) => {
        const current = prev[threadId] ?? [];
        const next = updater(current);
        if (next.length === 0) {
          const { [threadId]: _removed, ...rest } = prev;
          return rest;
        }
        return {
          ...prev,
          [threadId]: next,
        };
      });
    },
    [],
  );

  const queueOutboundMessage = useCallback(
    (input: {
      threadId: string;
      text: string;
      visibleContent: string;
      attachedFiles?: QueuedOutboundAttachment[];
      mode: "fast" | "high";
      workflowInvocation?: WorkflowInvocation;
    }): QueuedOutboundMessage => {
      const queuedMessage: QueuedOutboundMessage = {
        id: `queued-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        threadId: input.threadId,
        text: input.text,
        visibleContent: input.visibleContent,
        createdAt: new Date().toISOString(),
        mode: input.mode,
        attachedFiles: input.attachedFiles,
        workflowInvocation: input.workflowInvocation,
      };
      upsertQueuedMessagesForThread(input.threadId, (current) => [
        ...current,
        queuedMessage,
      ]);
      return queuedMessage;
    },
    [upsertQueuedMessagesForThread],
  );

  const removeQueuedMessageById = useCallback(
    (queuedMessageId: string): QueuedOutboundMessage | null => {
      let removed: QueuedOutboundMessage | null = null;
      setQueuedMessagesByThread((prev) => {
        const next: Record<string, QueuedOutboundMessage[]> = {};
        for (const [threadId, queue] of Object.entries(prev)) {
          const filtered = queue.filter((item) => {
            if (item.id === queuedMessageId) {
              removed = item;
              return false;
            }
            return true;
          });
          if (filtered.length > 0) {
            next[threadId] = filtered;
          }
        }
        return next;
      });
      return removed;
    },
    [],
  );

  const dispatchOutgoingMessage = useCallback(
    async (input: {
      threadId: string;
      text: string;
      visibleContent: string;
      attachedFiles?: QueuedOutboundAttachment[];
      mode: "fast" | "high";
      workflowInvocation?: WorkflowInvocation;
    }) => {
      if (!token || !currentWorkspace) return false;

      const userMsg: Message = {
        id: `temp-${Date.now()}`,
        threadId: input.threadId,
        role: "user",
        content: input.visibleContent,
        metadata:
          input.attachedFiles && input.attachedFiles.length > 0
            ? { attachedFiles: input.attachedFiles }
            : undefined,
        createdAt: new Date().toISOString(),
      };

      cancelRequestedRef.current = false;
      activeModeRef.current = input.mode;
      setMessages((prev) => [...prev, userMsg]);
      setIsStreaming(true);
      setIsThinking(false);
      replaceActivePlan(null);
      activeExecutionMessageIdRef.current = null;
      setLiveBlocks([]);
      liveBlocksRef.current = [];
      setError(null);

      try {
        const requestId = crypto.randomUUID();
        activeRequestIdRef.current = requestId;
        replaceActiveExecutionId(requestId);
        const sendRes = await window.desktopAPI.chat.startStream(
          token,
          input.threadId,
          input.text,
          requestId,
          input.attachedFiles,
          input.mode,
          { name: currentWorkspace.name, path: currentWorkspace.path },
          input.workflowInvocation,
        );
        if (!sendRes.success) {
          setError("Failed to send message");
          setIsStreaming(false);
          setIsThinking(false);
          activeRequestIdRef.current = null;
          replaceActiveExecutionId(null);
          setMessages((prev) => prev.filter((message) => message.id !== userMsg.id));
          return false;
        }
        return true;
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          setError("Stream failed. Please try again.");
        }
        setIsStreaming(false);
        setIsThinking(false);
        activeRequestIdRef.current = null;
        replaceActiveExecutionId(null);
        setMessages((prev) => prev.filter((message) => message.id !== userMsg.id));
        return false;
      }
    },
    [currentWorkspace, replaceActiveExecutionId, replaceActivePlan, token],
  );

  const clearError = useCallback(() => setError(null), []);

  const editQueuedMessage = useCallback(
    (queuedMessageId: string): QueuedOutboundMessage | null =>
      removeQueuedMessageById(queuedMessageId),
    [removeQueuedMessageById],
  );

  const deleteQueuedMessage = useCallback((queuedMessageId: string) => {
    removeQueuedMessageById(queuedMessageId);
  }, [removeQueuedMessageById]);

  useEffect(() => {
    const activeThreadId = activeThreadRef.current?.id;
    if (!activeThreadId) return;
    if (flushingQueuedMessageRef.current) return;
    if (isStreaming || isThinking) return;
    if (activeExecutionIdRef.current) return;
    if (pendingLocalActionRef.current || runningCommandRef.current) return;
    if (activeRequestIdRef.current) return;

    const nextQueuedMessage =
      queuedMessagesByThreadRef.current[activeThreadId]?.[0] ?? null;
    if (!nextQueuedMessage) return;

    const removedQueuedMessage = removeQueuedMessageById(nextQueuedMessage.id);
    if (!removedQueuedMessage) return;

    flushingQueuedMessageRef.current = true;
    void (async () => {
      const didDispatch = await dispatchOutgoingMessage({
        threadId: removedQueuedMessage.threadId,
        text: removedQueuedMessage.text,
        visibleContent: removedQueuedMessage.visibleContent,
        attachedFiles: removedQueuedMessage.attachedFiles,
        mode: removedQueuedMessage.mode,
        workflowInvocation: removedQueuedMessage.workflowInvocation,
      });
      if (!didDispatch) {
        upsertQueuedMessagesForThread(removedQueuedMessage.threadId, (current) => [
          removedQueuedMessage,
          ...current,
        ]);
      }
      flushingQueuedMessageRef.current = false;
    })();
  }, [
    dispatchOutgoingMessage,
    isStreaming,
    isThinking,
    pendingLocalAction,
    queuedMessagesByThread,
    removeQueuedMessageById,
    upsertQueuedMessagesForThread,
  ]);

  const deleteThread = useCallback(
    async (threadId: string) => {
      if (isStreaming) return;
      if (!token) return;
      deletingThreadIdsRef.current.add(threadId);
      clearEphemeralRuntimeCacheForThread(threadId);
      clearCachedThreadPage(threadId);
      upsertQueuedMessagesForThread(threadId, () => []);
      const wasActive = activeThreadRef.current?.id === threadId;
      unbindThread(threadId);
      setAllThreads((prev) => prev.filter((thread) => thread.id !== threadId));
      if (wasActive) {
        activeThreadRef.current = null;
        setActiveThread(null);
        setMessages([]);
        setThreadPagination({
          hasMoreOlder: false,
          nextBeforeMessageId: null,
          limit: INITIAL_THREAD_MESSAGE_LIMIT,
        });
        setIsThreadLoading(false);
        setIsLoadingOlderMessages(false);
        replaceActivePlan(null);
        resetLiveState();
      }
      try {
        const result = await window.desktopAPI.threads.delete(token, threadId);
        if (!result?.success) {
          setError("Failed to delete thread");
          deletingThreadIdsRef.current.delete(threadId);
          void loadThreadsRef.current?.();
          return;
        }
      } catch {
        deletingThreadIdsRef.current.delete(threadId);
        void loadThreadsRef.current?.();
        setError(
          "Failed to delete thread — please restart the app and try again",
        );
        return;
      }
      deletingThreadIdsRef.current.delete(threadId);
    },
    [
      clearCachedThreadPage,
      clearEphemeralRuntimeCacheForThread,
      token,
      isStreaming,
      replaceActivePlan,
      resetLiveState,
      unbindThread,
      upsertQueuedMessagesForThread,
    ],
  );

  const queuedMessages = activeThread
    ? queuedMessagesByThread[activeThread.id] ?? []
    : [];

  return (
    <ChatContext.Provider
      value={{
        threads,
        activeThread,
        messages,
        isThreadLoading,
        isLoadingOlderMessages,
        hasMoreHistory: threadPagination.hasMoreOlder,
        isStreaming,
        isThinking,
        autoApproveLocalActions,
        activePlan,
        liveBlocks,
        pendingLocalAction,
        queuedMessages,
        error,
        loadThreads,
        selectThread,
        loadOlderMessages,
        createThread,
        deleteThread,
        sendMessage,
        sendInitialMessage,
        stopExecution,
        approveCommand,
        rejectCommand,
        killCommand,
        editQueuedMessage,
        deleteQueuedMessage,
        setAutoApproveLocalActions,
        clearError,
      }}
    >
      {children}
    </ChatContext.Provider>
  );
}

export function useChat(): ChatState {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("useChat must be used within ChatProvider");
  return ctx;
}
