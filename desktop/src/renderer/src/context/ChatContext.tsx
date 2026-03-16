import {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  useEffect,
  type ReactNode,
} from 'react'
import type {
  Thread,
  Message,
  ContentBlock,
  MessageMetadata,
  ExecutionPlan,
  ExecutionEventItem,
  ThreadMessagesPage,
  ThreadMessagePagination,
} from '../types'
import { useAuth } from './AuthContext'
import { useWorkspace } from './WorkspaceContext'
import {
  isLikelyLocalWorkspaceIntent,
  buildApprovalBlock,
  buildAgentActionToolBlock,
  buildTerminalBlock,
  normalizeDesktopWorkspaceAction,
  isApprovalRequiredAction,
  isImmediateWorkspaceAction,
  summarizeCommandCompletion,
  summarizeWorkspaceAction,
  type DesktopWorkspaceAction,
  type NonCommandWorkspaceAction,
  type PendingLocalActionState,
  type RunningCommandState,
  type ActionLoopResult,
  type ActionResultPayload,
  type ActionCompletion,
} from '../lib/chat-helpers'
import { applyLiveStreamEventToLedger, replayExecutionEvents } from '../lib/execution-ledger'
import { appendFrontendDebugLog } from '../lib/frontend-debug-log'

export type { DesktopWorkspaceAction, ActionResultPayload }

// ── Context contract ──────────────────────────────────────────────────────────

interface ChatState {
  threads: Thread[]
  activeThread: Thread | null
  messages: Message[]
  isThreadLoading: boolean
  isLoadingOlderMessages: boolean
  hasMoreHistory: boolean
  isStreaming: boolean
  isThinking: boolean
  activePlan: ExecutionPlan | null
  liveBlocks: ContentBlock[]
  selectedEngine: 'mastra' | 'langgraph'
  error: string | null
  loadThreads: () => Promise<void>
  selectThread: (threadId: string) => Promise<void>
  loadOlderMessages: () => Promise<void>
  createThread: () => Promise<string | null>
  deleteThread: (threadId: string) => Promise<void>
  setSelectedEngine: (engine: 'mastra' | 'langgraph') => Promise<void>
  sendMessage: (
    text: string,
    attachedFiles?: Array<{ fileAssetId: string; cloudinaryUrl: string; mimeType: string; fileName: string }>,
    mode?: 'fast' | 'high' | 'xtreme'
  ) => Promise<void>
  sendInitialMessage: (
    text: string,
    attachedFiles?: Array<{ fileAssetId: string; cloudinaryUrl: string; mimeType: string; fileName: string }>,
    mode?: 'fast' | 'high' | 'xtreme'
  ) => Promise<void>
  stopExecution: () => Promise<void>
  approveCommand: (executionId: string) => Promise<void>
  rejectCommand: (executionId: string) => Promise<void>
  killCommand: (executionId: string) => Promise<void>
  clearError: () => void
}

const ChatContext = createContext<ChatState | null>(null)

const INITIAL_THREAD_MESSAGE_LIMIT = 6
const OLDER_THREAD_MESSAGE_LIMIT = 20
const ACTIVE_THREAD_KEY = 'cursorr_desktop_active_thread_by_workspace'
const LIVE_SESSION_KEY = 'cursorr_desktop_live_session'
const MAX_PERSISTED_TOOL_BLOCKS = 24
const MAX_BACKEND_PLAN_GOAL_CHARS = 240
const MAX_BACKEND_PLAN_TASKS = 6
const MAX_BACKEND_PLAN_TASK_TITLE_CHARS = 160
const MAX_BACKEND_PLAN_RESULT_CHARS = 500

type PersistedActiveThreadMap = Record<string, string>

type PersistedLiveSession = {
  workspaceId: string
  threadId: string
  requestId: string | null
  executionId: string | null
  engine: 'mastra' | 'langgraph'
  mode: 'fast' | 'high' | 'xtreme'
  isStreaming: boolean
  isThinking: boolean
  activePlan: ExecutionPlan | null
  liveBlocks: ContentBlock[]
  pendingLocalAction: PendingLocalActionState | null
  runningCommand: RunningCommandState | null
}

const readStoredJson = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

const compactLiveBlocksForPersistence = (blocks: ContentBlock[]): ContentBlock[] => {
  const recentTools = blocks
    .filter((block): block is Extract<ContentBlock, { type: 'tool' }> => block.type === 'tool')
    .slice(-MAX_PERSISTED_TOOL_BLOCKS)
  const important = blocks.filter((block) => block.type === 'approval' || block.type === 'terminal')
  const trailing = blocks.filter((block) => block.type === 'text' || block.type === 'thinking').slice(-2)
  return [...recentTools, ...important, ...trailing]
}

const rebuildRecoverableBlocks = (input: {
  blocks: ContentBlock[]
  pendingLocalAction: PendingLocalActionState | null
  runningCommand: RunningCommandState | null
  workspacePath: string
}): ContentBlock[] => {
  const next = [...input.blocks]
  if (input.pendingLocalAction && isApprovalRequiredAction(input.pendingLocalAction.action)) {
    const hasApproval = next.some((block) => block.type === 'approval' && block.id === input.pendingLocalAction!.id)
    if (!hasApproval) {
      next.push(
        buildApprovalBlock(
          input.pendingLocalAction.id,
          input.pendingLocalAction.action,
          input.pendingLocalAction.workspacePath || input.workspacePath,
          input.pendingLocalAction.status && input.pendingLocalAction.status !== 'pending' ? 'approved' : 'pending',
        ),
      )
    }
  }
  if (input.runningCommand) {
    const hasTerminal = next.some((block) => block.type === 'terminal' && block.id === input.runningCommand!.id)
    if (!hasTerminal) {
      next.push(
        buildTerminalBlock(
          input.runningCommand.id,
          input.runningCommand.command,
          input.runningCommand.cwd,
          'running',
        ),
      )
    }
  }
  return next
}

const prependDistinctMessages = (older: Message[], current: Message[]): Message[] => {
  if (older.length === 0) {
    return current
  }

  const seen = new Set(current.map((message) => message.id))
  const uniqueOlder = older.filter((message) => !seen.has(message.id))
  return uniqueOlder.length > 0 ? [...uniqueOlder, ...current] : current
}

const truncateForBackend = (value: string | null | undefined, max: number): string | undefined => {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max)
}

const sanitizePlanForBackend = (plan: ExecutionPlan | null): ExecutionPlan | null => {
  if (!plan) return null
  return {
    ...plan,
    goal: truncateForBackend(plan.goal, MAX_BACKEND_PLAN_GOAL_CHARS) ?? 'Continue the current task',
    tasks: plan.tasks.slice(0, MAX_BACKEND_PLAN_TASKS).map((task) => ({
      ...task,
      title: truncateForBackend(task.title, MAX_BACKEND_PLAN_TASK_TITLE_CHARS) ?? 'Untitled task',
      ...(task.resultSummary
        ? { resultSummary: truncateForBackend(task.resultSummary, MAX_BACKEND_PLAN_RESULT_CHARS) }
        : {}),
    })),
  }
}

// ── Provider ──────────────────────────────────────────────────────────────────

export function ChatProvider({ children }: { children: ReactNode }): JSX.Element {
  const { token } = useAuth()
  const {
    currentWorkspace,
    bindThreadToCurrentWorkspace,
    unbindThread,
    isThreadInCurrentWorkspace,
  } = useWorkspace()

  // ── Core state ──
  const [allThreads, setAllThreads] = useState<Thread[]>([])
  const [activeThread, setActiveThread] = useState<Thread | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [threadPagination, setThreadPagination] = useState<ThreadMessagePagination>({
    hasMoreOlder: false,
    nextBeforeMessageId: null,
    limit: INITIAL_THREAD_MESSAGE_LIMIT,
  })
  const [isThreadLoading, setIsThreadLoading] = useState(false)
  const [isLoadingOlderMessages, setIsLoadingOlderMessages] = useState(false)
  const [isStreaming, setIsStreaming] = useState(false)
  const [isThinking, setIsThinking] = useState(false)
  const [activePlan, setActivePlan] = useState<ExecutionPlan | null>(null)
  const [liveBlocks, setLiveBlocks] = useState<ContentBlock[]>([])
  const [selectedEngine, setSelectedEngineState] = useState<'mastra' | 'langgraph'>('langgraph')
  const [error, setError] = useState<string | null>(null)

  // ── Refs for mutable cross-callback access ──
  const activeRequestIdRef = useRef<string | null>(null)
  const activeThreadRef = useRef<Thread | null>(null)
  const activeThreadLoadVersionRef = useRef(0)
  const activePlanRef = useRef<ExecutionPlan | null>(null)
  const activeExecutionIdRef = useRef<string | null>(null)
  const liveBlocksRef = useRef<ContentBlock[]>([])
  const liveThinkingStartedAtRef = useRef<number | null>(null)
  const liveExecutionEventsRef = useRef<Array<{ type: string; data: unknown; createdAtMs: number }>>([])
  const executionEventCacheRef = useRef<Map<string, ExecutionEventItem[]>>(new Map())
  const isRecoveringStreamRef = useRef(false)
  const lastEventTimestampRef = useRef<number>(Date.now())
  const isStreamingRef = useRef(false)
  const loadThreadsRef = useRef<(() => Promise<void>) | null>(null)
  const pendingLocalActionRef = useRef<PendingLocalActionState | null>(null)
  const runningCommandRef = useRef<RunningCommandState | null>(null)
  const cancelRequestedRef = useRef(false)
  const activeModeRef = useRef<'fast' | 'high' | 'xtreme'>('xtreme')
  const selectedEngineRef = useRef<'mastra' | 'langgraph'>('langgraph')
  const activeExecutionEngineRef = useRef<'mastra' | 'langgraph'>('langgraph')

  useEffect(() => {
    appendFrontendDebugLog('chat', 'provider_mounted', {
      hasWorkspace: Boolean(currentWorkspace),
      workspaceId: currentWorkspace?.id,
    })
    if (import.meta.hot) {
      appendFrontendDebugLog('chat', 'hmr_enabled')
    }
  }, [currentWorkspace])

  // ── Shared live-block utilities ──
  const appendOutput = useCallback((prev: string, chunk: string): string => {
    const next = prev + chunk
    const maxChars = 24000
    return next.length > maxChars ? next.slice(next.length - maxChars) : next
  }, [])

  const replaceLiveBlocks = useCallback((updater: (prev: ContentBlock[]) => ContentBlock[]) => {
    setLiveBlocks((prev) => {
      const next = updater(prev)
      liveBlocksRef.current = next
      return next
    })
  }, [])

  const replaceActivePlan = useCallback((plan: ExecutionPlan | null) => {
    activePlanRef.current = plan
    setActivePlan(plan)
  }, [])

  const applyLiveLedgerEvent = useCallback((event: { type: string; data: unknown }) => {
    const createdAtMs = Date.now()
    liveExecutionEventsRef.current = [...liveExecutionEventsRef.current, { ...event, createdAtMs }]
    const next = applyLiveStreamEventToLedger({
      blocks: liveBlocksRef.current,
      plan: activePlanRef.current,
      activeThinkingStartedAtMs: liveThinkingStartedAtRef.current,
      event,
      createdAtMs,
    })
    liveThinkingStartedAtRef.current = next.activeThinkingStartedAtMs
    replaceLiveBlocks(() => next.blocks)
    replaceActivePlan(next.plan)
  }, [replaceActivePlan, replaceLiveBlocks])

  const ensureStreamingThinkingBlock = useCallback(() => {
    setIsThinking(true)
    if (liveThinkingStartedAtRef.current == null) {
      liveThinkingStartedAtRef.current = Date.now()
    }
    replaceLiveBlocks((prev) => {
      const last = prev[prev.length - 1]
      if (last?.type === 'thinking') return prev
      return [...prev, { type: 'thinking' }]
    })
  }, [replaceLiveBlocks])

  const replaceSelectedEngine = useCallback((engine: 'mastra' | 'langgraph') => {
    selectedEngineRef.current = engine
    setSelectedEngineState(engine)
  }, [])

  const replaceActiveExecutionId = useCallback((executionId: string | null) => {
    activeExecutionIdRef.current = executionId
  }, [])

  useEffect(() => {
    isStreamingRef.current = isStreaming
  }, [isStreaming])

  const persistExecutionSession = useCallback(() => {
    if (!currentWorkspace || !activeThreadRef.current?.id) {
      localStorage.removeItem(LIVE_SESSION_KEY)
      return
    }

    const hasRecoverableState =
      Boolean(activeRequestIdRef.current)
      || Boolean(activeExecutionIdRef.current)
      || Boolean(pendingLocalActionRef.current)
      || Boolean(runningCommandRef.current)
      || liveBlocksRef.current.length > 0
      || isStreaming
      || isThinking

    if (!hasRecoverableState) {
      localStorage.removeItem(LIVE_SESSION_KEY)
      return
    }

    const payload: PersistedLiveSession = {
      workspaceId: currentWorkspace.id,
      threadId: activeThreadRef.current.id,
      requestId: activeRequestIdRef.current,
      executionId: activeExecutionIdRef.current,
      engine: activeExecutionEngineRef.current,
      mode: activeModeRef.current,
      isStreaming,
      isThinking,
      activePlan: activePlanRef.current,
      liveBlocks: compactLiveBlocksForPersistence(liveBlocksRef.current),
      pendingLocalAction: pendingLocalActionRef.current,
      runningCommand: runningCommandRef.current,
    }
    try {
      localStorage.setItem(LIVE_SESSION_KEY, JSON.stringify(payload))
    } catch {
      try {
        localStorage.setItem(LIVE_SESSION_KEY, JSON.stringify({
          ...payload,
          activePlan: null,
          liveBlocks: rebuildRecoverableBlocks({
            blocks: [],
            pendingLocalAction: pendingLocalActionRef.current,
            runningCommand: runningCommandRef.current,
            workspacePath: currentWorkspace.path,
          }),
        } satisfies PersistedLiveSession))
      } catch {
        setError('Live execution recovery could not be saved for this run.')
      }
    }
  }, [currentWorkspace, isStreaming, isThinking])

  const fetchExecutionEvents = useCallback(async (executionId: string): Promise<ExecutionEventItem[]> => {
    const cached = executionEventCacheRef.current.get(executionId)
    if (cached) return cached
    if (!token) return []

    const response = await window.desktopAPI.fetch(`/api/desktop/executions/${executionId}/events`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (response.status < 200 || response.status >= 300) {
      return []
    }
    const body = JSON.parse(response.body) as { data?: { items?: ExecutionEventItem[] } }
    const events = Array.isArray(body.data?.items) ? body.data.items : []
    if (events.length > 0) {
      executionEventCacheRef.current.set(executionId, events)
    }
    return events
  }, [token])

  const persistActiveThread = useCallback((threadId: string | null) => {
    if (!currentWorkspace) return
    const next = readStoredJson<PersistedActiveThreadMap>(ACTIVE_THREAD_KEY, {})
    if (threadId) next[currentWorkspace.id] = threadId
    else delete next[currentWorkspace.id]
    localStorage.setItem(ACTIVE_THREAD_KEY, JSON.stringify(next))
  }, [currentWorkspace])

  const resetLiveState = useCallback(() => {
    setLiveBlocks([])
    liveBlocksRef.current = []
    liveThinkingStartedAtRef.current = null
    liveExecutionEventsRef.current = []
    isRecoveringStreamRef.current = false
    setIsStreaming(false)
    setIsThinking(false)
    replaceActivePlan(null)
    replaceActiveExecutionId(null)
    activeRequestIdRef.current = null
    activeExecutionEngineRef.current = selectedEngineRef.current
    pendingLocalActionRef.current = null
    runningCommandRef.current = null
    localStorage.removeItem(LIVE_SESSION_KEY)
  }, [replaceActiveExecutionId, replaceActivePlan])

  const commitPartialAssistant = useCallback(() => {
    const blocks = liveBlocksRef.current
    if (blocks.length === 0) return
    const textContent = blocks
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map((block) => block.content)
      .join('')
    setMessages((prev) => [
      ...prev,
      {
        id: `assistant-partial-${Date.now()}`,
        threadId: activeThreadRef.current?.id ?? '',
        role: 'assistant',
        content: textContent,
        createdAt: new Date().toISOString(),
        metadata: { contentBlocks: blocks, streaming: false },
      },
    ])
  }, [])

  // ── Persist a local action summary to the thread ──
  const persistLocalSummary = useCallback(async (input: {
    threadId: string
    content: string
    metadata?: MessageMetadata
  }) => {
    if (!token) return
    try {
      await window.desktopAPI.threads.addMessage(token, input.threadId, {
        role: 'assistant',
        content: input.content,
        metadata: input.metadata as Record<string, unknown> | undefined,
      })
    } catch {
      setError('Local action finished, but saving the summary log failed.')
    }
  }, [token])

  // ── Finalize an agent-driven local action turn ──
  const finalizeLocalBlocks = useCallback(async (input: {
    threadId: string
    summaryContent?: string
    summaryMetadata?: MessageMetadata
    appendPersistedMessage?: Message | null
  }) => {
    const finalizedBlocks = liveBlocksRef.current

    if (finalizedBlocks.length > 0) {
      setMessages((prev) => [
        ...prev,
        {
          id: `local-action-${Date.now()}`,
          threadId: input.threadId,
          role: 'assistant',
          content: '',
          createdAt: new Date().toISOString(),
          metadata: { contentBlocks: finalizedBlocks },
        },
      ])
    }

    if (input.appendPersistedMessage) {
      setMessages((prev) => [...prev, input.appendPersistedMessage!])
    }

    if (input.summaryContent) {
      await persistLocalSummary({
        threadId: input.threadId,
        content: input.summaryContent,
        metadata: input.summaryMetadata,
      })
    }

    void loadThreadsRef.current?.()
    resetLiveState()
  }, [persistLocalSummary, resetLiveState])

  // ── Execute a non-command workspace action ──
  const runWorkspaceAction = useCallback(async (input: {
    action: NonCommandWorkspaceAction
    toolBlockId: string
    threadId: string
  }): Promise<ActionCompletion> => {
    if (!currentWorkspace) {
      const failed = summarizeWorkspaceAction(input.action, { success: false, error: 'No workspace selected' })
      replaceLiveBlocks((prev) =>
        prev.map((block) =>
          block.type === 'tool' && block.id === input.toolBlockId
            ? { ...block, status: 'failed', resultSummary: failed.toolResultSummary }
            : block,
        ),
      )
      return failed
    }

    const result = await window.desktopAPI.workspace.runAction(currentWorkspace.path, input.action)
    const completion = summarizeWorkspaceAction(input.action, result)

    replaceLiveBlocks((prev) =>
      prev.map((block) =>
        block.type === 'tool' && block.id === input.toolBlockId
          ? { ...block, status: completion.ok ? 'done' : 'failed', resultSummary: completion.toolResultSummary }
          : block,
      ),
    )

    await persistLocalSummary({ threadId: input.threadId, content: completion.summaryContent, metadata: completion.summaryMetadata })
    return completion
  }, [currentWorkspace, persistLocalSummary, replaceLiveBlocks])

  // ── Run one agentic action loop turn ──
  const runAgentLocalActionTurn = useCallback(async (input: {
    threadId: string
    initialMessage?: string
    actionResult?: ActionResultPayload
    engineOverride?: 'mastra' | 'langgraph'
  }): Promise<void> => {
    if (!token || !currentWorkspace) return
    try {
      const engine = input.engineOverride ?? selectedEngineRef.current
      activeExecutionEngineRef.current = engine
      const canUseActStream = engine === 'langgraph' && typeof window.desktopAPI.chat.actStream === 'function'
      const canUseActJson = typeof window.desktopAPI.chat.act === 'function'
      if (!canUseActStream && !canUseActJson) {
        setError('Workspace tools are not loaded in this desktop session. Restart the Electron app to enable file and terminal actions.')
        resetLiveState()
        return
      }

      ensureStreamingThinkingBlock()

      if (engine === 'langgraph' && typeof window.desktopAPI.chat.actStream === 'function') {
        const executionId = activeExecutionIdRef.current ?? crypto.randomUUID()
        const requestId = crypto.randomUUID()
        appendFrontendDebugLog('chat', 'act_stream_start', {
          threadId: input.threadId,
          requestId,
          executionId,
          hasInitialMessage: Boolean(input.initialMessage),
          hasActionResult: Boolean(input.actionResult),
        })
        activeRequestIdRef.current = requestId
        replaceActiveExecutionId(executionId)
        setIsStreaming(true)

        const streamResult = await window.desktopAPI.chat.actStream({
          token,
          requestId,
          executionId,
          threadId: input.threadId,
          message: input.initialMessage,
          workspace: { name: currentWorkspace.name, path: currentWorkspace.path },
          actionResult: input.actionResult,
          ...(activePlanRef.current ? { plan: sanitizePlanForBackend(activePlanRef.current) } : {}),
          mode: activeModeRef.current,
          engine,
        })

        if (!streamResult.success) {
          appendFrontendDebugLog('chat', 'act_stream_failed', {
            threadId: input.threadId,
            requestId,
            executionId,
            error: streamResult.error ?? 'Desktop action loop failed',
          })
          throw new Error(streamResult.error ?? 'Desktop action loop failed')
        }
        appendFrontendDebugLog('chat', 'act_stream_started', {
          threadId: input.threadId,
          requestId,
          executionId,
        })
        return
      }

      const response = await window.desktopAPI.chat.act(token, input.threadId, {
        message: input.initialMessage,
        workspace: { name: currentWorkspace.name, path: currentWorkspace.path },
        actionResult: input.actionResult,
        ...(activePlanRef.current ? { plan: sanitizePlanForBackend(activePlanRef.current) } : {}),
        mode: activeModeRef.current,
        engine,
        executionId: activeExecutionIdRef.current ?? crypto.randomUUID(),
      })

      if (!response.success || !response.data) throw new Error(response.message || 'Desktop action loop failed')
      if (cancelRequestedRef.current) return

      const payload = response.data as ActionLoopResult
      replaceActiveExecutionId(payload.executionId ?? activeExecutionIdRef.current)
      replaceActivePlan(payload.plan ?? null)

      if (payload.kind === 'answer') {
        setIsThinking(false)
        await finalizeLocalBlocks({ threadId: input.threadId, appendPersistedMessage: payload.message })
        return
      }

      const { action } = payload
      setIsThinking(false)

      if (action.kind === 'list_files' || action.kind === 'read_file') {
        const toolBlock = buildAgentActionToolBlock(action)
        replaceLiveBlocks((prev) => [...prev, toolBlock])
        const completion = await runWorkspaceAction({ action, toolBlockId: toolBlock.id, threadId: input.threadId })
        if (cancelRequestedRef.current) return
        await runAgentLocalActionTurn({
          threadId: input.threadId,
          actionResult: { kind: action.kind, ok: completion.ok, summary: completion.actionResultSummary, details: completion.actionResultDetails },
          engineOverride: engine,
        })
        return
      }

      const actionId = crypto.randomUUID()
      pendingLocalActionRef.current = {
        id: actionId,
        threadId: input.threadId,
        workspaceName: currentWorkspace.name,
        workspacePath: currentWorkspace.path,
        action,
        source: 'agent',
        engine,
      }
      persistExecutionSession()

      replaceLiveBlocks((prev) => [
        ...prev,
        buildApprovalBlock(
          actionId,
          action as Extract<DesktopWorkspaceAction, { kind: 'run_command' | 'write_file' | 'mkdir' | 'delete_path' }>,
          currentWorkspace.path,
        ),
      ])
    } catch (err) {
      appendFrontendDebugLog('chat', 'action_loop_failed', {
        threadId: input.threadId,
        error: err instanceof Error ? err.message : 'Desktop action loop failed',
      })
      setError(err instanceof Error ? err.message : 'Desktop action loop failed')
      resetLiveState()
    }
  }, [currentWorkspace, ensureStreamingThinkingBlock, finalizeLocalBlocks, persistExecutionSession, replaceActiveExecutionId, replaceActivePlan, replaceLiveBlocks, resetLiveState, runWorkspaceAction, token])

  // ── Finish a terminal command execution ──
  const finishCommandExecution = useCallback(async (input: {
    executionId: string
    status: 'done' | 'failed'
    exitCode?: number | null
    signal?: string | null
    durationMs?: number
  }) => {
    const runningCommand = runningCommandRef.current
    if (!runningCommand || runningCommand.id !== input.executionId) return

    const terminalBlock = liveBlocksRef.current.find(
      (block): block is Extract<ContentBlock, { type: 'terminal' }> =>
        block.type === 'terminal' && block.id === input.executionId,
    )

    const completion = summarizeCommandCompletion({
      command: runningCommand.command,
      cwd: runningCommand.cwd,
      status: input.status,
      exitCode: input.exitCode,
      signal: input.signal,
      durationMs: input.durationMs,
      stdout: terminalBlock?.stdout,
      stderr: terminalBlock?.stderr,
    })

    await persistLocalSummary({ threadId: runningCommand.threadId, content: completion.summaryContent, metadata: completion.summaryMetadata })
    runningCommandRef.current = null

    if (runningCommand.source === 'agent') {
      if (cancelRequestedRef.current) return
      await runAgentLocalActionTurn({
        threadId: runningCommand.threadId,
        actionResult: { kind: 'run_command', ok: completion.ok, summary: completion.actionResultSummary, details: completion.actionResultDetails },
        engineOverride: runningCommand.engine,
      })
      return
    }

    await finalizeLocalBlocks({ threadId: runningCommand.threadId })
  }, [finalizeLocalBlocks, persistLocalSummary, replaceActivePlan, runAgentLocalActionTurn])

  // ── Terminal event subscriber ──
  useEffect(() => {
    const unsubscribe = window.desktopAPI.terminal.onEvent(({ executionId, event }) => {
      const runningCommand = runningCommandRef.current
      if (!runningCommand || runningCommand.id !== executionId) return

      switch (event.type) {
        case 'stdout': {
          const chunk = String(event.data ?? '')
          replaceLiveBlocks((prev) => prev.map((block) => block.type === 'terminal' && block.id === executionId ? { ...block, stdout: appendOutput(block.stdout, chunk) } : block))
          break
        }
        case 'stderr': {
          const chunk = String(event.data ?? '')
          replaceLiveBlocks((prev) => prev.map((block) => block.type === 'terminal' && block.id === executionId ? { ...block, stderr: appendOutput(block.stderr, chunk) } : block))
          break
        }
        case 'error': {
          const raw = event.data as { message?: string; durationMs?: number }
          replaceLiveBlocks((prev) => prev.map((block) => block.type === 'terminal' && block.id === executionId ? { ...block, status: 'failed', stderr: appendOutput(block.stderr, `${raw.message ?? 'Execution failed'}\n`), durationMs: raw.durationMs } : block))
          void finishCommandExecution({ executionId, status: 'failed', durationMs: raw.durationMs })
          break
        }
        case 'exit': {
          const raw = event.data as { exitCode?: number | null; signal?: string | null; durationMs?: number }
          const terminalStatus: 'done' | 'failed' = raw.exitCode === 0 ? 'done' : 'failed'
          replaceLiveBlocks((prev) => prev.map((block) => block.type === 'terminal' && block.id === executionId ? { ...block, status: terminalStatus, exitCode: raw.exitCode ?? null, signal: raw.signal ?? null, durationMs: raw.durationMs } : block))
          void finishCommandExecution({ executionId, status: terminalStatus, exitCode: raw.exitCode ?? null, signal: raw.signal ?? null, durationMs: raw.durationMs })
          break
        }
        default:
          break
      }
    })
    return unsubscribe
  }, [appendOutput, finishCommandExecution, replaceLiveBlocks])

  useEffect(() => { activeThreadRef.current = activeThread }, [activeThread])

  useEffect(() => {
    persistExecutionSession()
  }, [activeThread, liveBlocks, activePlan, isStreaming, isThinking, currentWorkspace, persistExecutionSession])

  useEffect(() => {
    persistActiveThread(activeThread?.id ?? null)
  }, [activeThread, persistActiveThread])

  useEffect(() => {
    if (!currentWorkspace) {
      setActiveThread(null)
      setMessages([])
      setThreadPagination({
        hasMoreOlder: false,
        nextBeforeMessageId: null,
        limit: INITIAL_THREAD_MESSAGE_LIMIT,
      })
      setIsThreadLoading(false)
      setIsLoadingOlderMessages(false)
      replaceActivePlan(null)
      replaceSelectedEngine('langgraph')
      return
    }
    if (activeThreadRef.current && !isThreadInCurrentWorkspace(activeThreadRef.current.id)) {
      setActiveThread(null)
      setMessages([])
      setThreadPagination({
        hasMoreOlder: false,
        nextBeforeMessageId: null,
        limit: INITIAL_THREAD_MESSAGE_LIMIT,
      })
      setIsThreadLoading(false)
      setIsLoadingOlderMessages(false)
      replaceActivePlan(null)
      replaceSelectedEngine('langgraph')
    }
  }, [currentWorkspace, isThreadInCurrentWorkspace, replaceActivePlan, replaceSelectedEngine])

  const threads = currentWorkspace ? allThreads.filter((thread) => isThreadInCurrentWorkspace(thread.id)) : []

  // ── Approval handlers ──
  const approveCommand = useCallback(async (executionId: string) => {
    const pendingAction = pendingLocalActionRef.current
    if (!pendingAction || pendingAction.id !== executionId) return

    replaceLiveBlocks((prev) => prev.map((block) => block.type === 'approval' && block.id === executionId ? { ...block, status: 'approved' as const } : block))
    pendingLocalActionRef.current = {
      ...pendingAction,
      status: 'approved',
    }
    persistExecutionSession()

    if (pendingAction.action.kind === 'run_command') {
      const command = pendingAction.action.command
      appendFrontendDebugLog('chat', 'approve_command', {
        executionId,
        threadId: pendingAction.threadId,
        command,
      })
      runningCommandRef.current = {
        id: executionId,
        threadId: pendingAction.threadId,
        workspaceName: pendingAction.workspaceName,
        cwd: pendingAction.workspacePath,
        command,
        source: pendingAction.source,
        engine: pendingAction.engine,
      }
      persistExecutionSession()
      replaceLiveBlocks((prev) => [...prev, { type: 'terminal', id: executionId, command, cwd: pendingAction.workspacePath, status: 'running', stdout: '', stderr: '' }])
      const result = await window.desktopAPI.terminal.exec(executionId, command, pendingAction.workspacePath)
      if (!result.success) {
        appendFrontendDebugLog('chat', 'terminal_exec_failed_to_start', {
          executionId,
          threadId: pendingAction.threadId,
          error: result.error ?? 'Execution failed',
        })
        replaceLiveBlocks((prev) => prev.map((block) => block.type === 'terminal' && block.id === executionId ? { ...block, status: 'failed', stderr: appendOutput(block.stderr, `${result.error ?? 'Execution failed'}\n`) } : block))
        await finishCommandExecution({ executionId, status: 'failed' })
      }
      return
    }

    const toolBlock = buildAgentActionToolBlock(pendingAction.action)
    replaceLiveBlocks((prev) => [...prev, toolBlock])
    const completion = await runWorkspaceAction({ action: pendingAction.action as NonCommandWorkspaceAction, toolBlockId: toolBlock.id, threadId: pendingAction.threadId })
    pendingLocalActionRef.current = null

    if (pendingAction.source === 'agent') {
      await runAgentLocalActionTurn({
        threadId: pendingAction.threadId,
        actionResult: { kind: pendingAction.action.kind, ok: completion.ok, summary: completion.actionResultSummary, details: completion.actionResultDetails },
        engineOverride: pendingAction.engine,
      })
      return
    }
    await finalizeLocalBlocks({ threadId: pendingAction.threadId })
  }, [appendOutput, finalizeLocalBlocks, finishCommandExecution, persistExecutionSession, replaceActivePlan, replaceLiveBlocks, runAgentLocalActionTurn, runWorkspaceAction])

  const rejectCommand = useCallback(async (executionId: string) => {
    const pendingAction = pendingLocalActionRef.current
    if (!pendingAction || pendingAction.id !== executionId) return

    replaceLiveBlocks((prev) => prev.map((block) => block.type === 'approval' && block.id === executionId ? { ...block, status: 'rejected' as const } : block))
    pendingLocalActionRef.current = null
    persistExecutionSession()

    if (pendingAction.action.kind === 'run_command') {
      const completion = summarizeCommandCompletion({ command: pendingAction.action.command, cwd: pendingAction.workspacePath, status: 'rejected' })
      if (pendingAction.source === 'agent') {
        await persistLocalSummary({ threadId: pendingAction.threadId, content: completion.summaryContent, metadata: completion.summaryMetadata })
        await runAgentLocalActionTurn({
          threadId: pendingAction.threadId,
          actionResult: { kind: 'run_command', ok: false, summary: completion.actionResultSummary, details: completion.actionResultDetails },
          engineOverride: pendingAction.engine,
        })
        return
      }
      await finalizeLocalBlocks({ threadId: pendingAction.threadId, summaryContent: completion.summaryContent, summaryMetadata: completion.summaryMetadata })
      return
    }

    const fileAction = pendingAction.action as Extract<DesktopWorkspaceAction, { kind: 'write_file' | 'mkdir' | 'delete_path' }>
    const summaryContent = `Rejected ${fileAction.kind.replace('_', ' ')} for \`${fileAction.path}\`.`
    const summaryMetadata: MessageMetadata = { localFileSummary: { kind: fileAction.kind, path: fileAction.path, status: 'rejected' } }
    if (pendingAction.source === 'agent') {
      await persistLocalSummary({ threadId: pendingAction.threadId, content: summaryContent, metadata: summaryMetadata })
      await runAgentLocalActionTurn({
        threadId: pendingAction.threadId,
        actionResult: { kind: fileAction.kind, ok: false, summary: `User rejected ${fileAction.kind} for ${fileAction.path}`, details: { path: fileAction.path } },
        engineOverride: pendingAction.engine,
      })
      return
    }
    await finalizeLocalBlocks({ threadId: pendingAction.threadId, summaryContent, summaryMetadata })
  }, [finalizeLocalBlocks, persistLocalSummary, replaceLiveBlocks, runAgentLocalActionTurn])

  const killCommand = useCallback(async (executionId: string) => {
    const runningCommand = runningCommandRef.current
    if (!runningCommand || runningCommand.id !== executionId) return
    const result = await window.desktopAPI.terminal.kill(executionId)
    if (!result.success) setError(result.error ?? 'Failed to stop command')
  }, [])

  // ── Thread management ──
  const loadThreads = useCallback(async () => {
    if (!token) return
    try {
      const res = await window.desktopAPI.threads.list(token)
      if (res.success && res.data) setAllThreads(res.data as Thread[])
    } catch {
      setError('Failed to load threads')
    }
  }, [token])

  useEffect(() => { loadThreadsRef.current = loadThreads }, [loadThreads])

  const selectThread = useCallback(async (threadId: string) => {
    if (!token || !currentWorkspace || !isThreadInCurrentWorkspace(threadId)) return
    const requestVersion = activeThreadLoadVersionRef.current + 1
    activeThreadLoadVersionRef.current = requestVersion
    const threadPreview = allThreads.find((thread) => thread.id === threadId) ?? null
    setActiveThread(threadPreview)
    setMessages([])
    setThreadPagination({
      hasMoreOlder: false,
      nextBeforeMessageId: null,
      limit: INITIAL_THREAD_MESSAGE_LIMIT,
    })
    setIsThreadLoading(true)
    setIsLoadingOlderMessages(false)
    try {
      const res = await window.desktopAPI.threads.get(token, threadId, { limit: INITIAL_THREAD_MESSAGE_LIMIT })
      if (res.success && res.data) {
        const data = res.data as ThreadMessagesPage
        if (activeThreadLoadVersionRef.current !== requestVersion) return
        const hydratedMessages = await hydrateMessagesWithExecutionEvents(data.messages)
        if (activeThreadLoadVersionRef.current !== requestVersion) return
        setActiveThread(data.thread)
        setMessages(hydratedMessages)
        setThreadPagination(data.pagination)
        replaceActivePlan(null)
        replaceSelectedEngine(data.thread.preferredEngine ?? 'langgraph')
        setError(null)
      }
    } catch {
      setError('Failed to load thread')
    } finally {
      if (activeThreadLoadVersionRef.current === requestVersion) {
        setIsThreadLoading(false)
      }
    }
  }, [allThreads, token, currentWorkspace, isThreadInCurrentWorkspace, replaceActivePlan, replaceSelectedEngine])

  useEffect(() => {
    if (!currentWorkspace || activeThreadRef.current || isThreadLoading || threads.length === 0) return
    const storedMap = readStoredJson<PersistedActiveThreadMap>(ACTIVE_THREAD_KEY, {})
    const storedThreadId = storedMap[currentWorkspace.id]
    if (!storedThreadId) return
    if (!threads.some((thread) => thread.id === storedThreadId)) return
    void selectThread(storedThreadId)
  }, [currentWorkspace, threads, isThreadLoading, selectThread])

  useEffect(() => {
    if (!currentWorkspace || !activeThread) return
    const stored = readStoredJson<PersistedLiveSession | null>(LIVE_SESSION_KEY, null)
    if (!stored) return
    if (stored.workspaceId !== currentWorkspace.id || stored.threadId !== activeThread.id) return
    if (
      activeExecutionIdRef.current
      || activeRequestIdRef.current
      || liveBlocksRef.current.length > 0
      || pendingLocalActionRef.current
      || runningCommandRef.current
    ) {
      return
    }

    activeRequestIdRef.current = stored.requestId
    replaceActiveExecutionId(stored.executionId)
    activeExecutionEngineRef.current = stored.engine
    activeModeRef.current = stored.mode
    pendingLocalActionRef.current = stored.pendingLocalAction
    runningCommandRef.current = stored.runningCommand
    replaceActivePlan(stored.activePlan ?? null)
    const recoveredBlocks = rebuildRecoverableBlocks({
      blocks: stored.liveBlocks ?? [],
      pendingLocalAction: stored.pendingLocalAction,
      runningCommand: stored.runningCommand,
      workspacePath: currentWorkspace.path,
    })
    setLiveBlocks(recoveredBlocks)
    liveBlocksRef.current = recoveredBlocks
    setIsStreaming(stored.isStreaming)
    setIsThinking(stored.isThinking)
  }, [activeThread, currentWorkspace, replaceActiveExecutionId, replaceActivePlan])

  async function hydrateMessagesWithExecutionEvents(items: Message[]): Promise<Message[]> {
    if (!token) return items

    const executionIds = Array.from(new Set(
      items
        .filter((message) => message.role === 'assistant' && typeof message.metadata?.executionId === 'string')
        .map((message) => message.metadata!.executionId!)
    ))

    if (executionIds.length === 0) return items

    const eventsByExecutionId = new Map<string, ExecutionEventItem[]>()

    await Promise.all(executionIds.map(async (executionId) => {
      try {
        const events = await fetchExecutionEvents(executionId)
        if (events.length > 0) {
          eventsByExecutionId.set(executionId, events)
        }
      } catch {
        // keep metadata fallback when ledger fetch is unavailable
      }
    }))

    return items.map((message) => {
      const executionId = message.metadata?.executionId
      if (!executionId) return message
      const events = eventsByExecutionId.get(executionId)
      if (!events || events.length === 0) return message
      const replayed = replayExecutionEvents(events)
      return {
        ...message,
        metadata: {
          ...(message.metadata ?? {}),
          executionId,
          contentBlocks: replayed.blocks,
          ...(replayed.plan ? { plan: replayed.plan } : {}),
        },
      }
    })
  }

  const recoverStreamingExecution = useCallback(async (): Promise<boolean> => {
    const executionId = activeExecutionIdRef.current
    const threadId = activeThreadRef.current?.id
    if (!token || !executionId || !threadId || isRecoveringStreamRef.current) return false
    isRecoveringStreamRef.current = true

    try {
      const [runResponse, events] = await Promise.all([
        window.desktopAPI.fetch(`/api/desktop/executions/${executionId}`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        fetchExecutionEvents(executionId),
      ])

      if (events.length > 0) {
        const replayed = replayExecutionEvents(events)
        liveBlocksRef.current = replayed.blocks
        setLiveBlocks(replayed.blocks)
        replaceActivePlan(replayed.plan)
      }

      if (runResponse.status >= 200 && runResponse.status < 300) {
        const runBody = JSON.parse(runResponse.body) as { data?: { run?: { status?: string } } }
        const status = runBody.data?.run?.status
        if (status === 'running') {
          lastEventTimestampRef.current = Date.now()
          setError(null)
          return true
        }
      }

      const threadRes = await window.desktopAPI.threads.get(token, threadId, { limit: INITIAL_THREAD_MESSAGE_LIMIT })
      if (threadRes.success && threadRes.data) {
        const data = threadRes.data as ThreadMessagesPage
        const hydratedMessages = await hydrateMessagesWithExecutionEvents(data.messages)
        setMessages(hydratedMessages)
        setThreadPagination(data.pagination)
      }
      cancelRequestedRef.current = false
      resetLiveState()
      return true
    } catch {
      return false
    } finally {
      isRecoveringStreamRef.current = false
    }
  }, [fetchExecutionEvents, hydrateMessagesWithExecutionEvents, replaceActivePlan, resetLiveState, token])

  // ── SSE stream event subscriber ──
  useEffect(() => {
    const unsubscribe = window.desktopAPI.chat.onStreamEvent(({ requestId, event }) => {
      if (activeRequestIdRef.current !== requestId) return
      lastEventTimestampRef.current = Date.now()

      switch (event.type) {
        case 'plan':
          applyLiveLedgerEvent({ type: event.type, data: event.data })
          break
        case 'progress': {
          const p = event.data as {
            type: string
            reason?: string
          }
          applyLiveLedgerEvent({ type: event.type, data: event.data })
          if (p.type === 'fail' && p.reason) setIsThinking(false)
          break
        }
        case 'thinking_token': {
          applyLiveLedgerEvent({ type: event.type, data: event.data })
          break
        }
        case 'thinking':
          setIsThinking(true)
          applyLiveLedgerEvent({ type: event.type, data: event.data })
          break
        case 'activity': {
          setIsThinking(false)
          applyLiveLedgerEvent({ type: event.type, data: event.data })
          break
        }
        case 'activity_done': {
          applyLiveLedgerEvent({ type: event.type, data: event.data })
          break
        }
        case 'text': {
          setIsThinking(false)
          applyLiveLedgerEvent({ type: event.type, data: event.data })
          break
        }
        case 'error':
          appendFrontendDebugLog('chat', 'terminal_event_error', {
            executionId,
            message: (event.data as { message?: string })?.message ?? 'Execution failed',
          })
          if (cancelRequestedRef.current) {
            cancelRequestedRef.current = false
            resetLiveState()
            break
          }
          setError(String(event.data ?? 'Stream failed. Please try again.'))
          resetLiveState()
          break
        case 'done': {
          appendFrontendDebugLog('chat', 'stream_done', {
            requestId,
            hasPersistedMessage: Boolean((event.data as { message?: Message } | null)?.message),
            liveBlockCount: liveBlocksRef.current.length,
          })
          const raw = event.data as { message?: Message } | null
          const persistedMessage = raw?.message
          setMessages((prev) => {
            if (persistedMessage) {
              const blocks = liveBlocksRef.current
              return [...prev, {
                ...persistedMessage,
                metadata: {
                  ...(persistedMessage.metadata ?? {}),
                  ...(persistedMessage.metadata?.executionId ? { executionId: persistedMessage.metadata.executionId } : {}),
                  ...(blocks.length > 0 ? { contentBlocks: blocks } : {}),
                  ...(activePlanRef.current ? { plan: activePlanRef.current } : {}),
                },
              }]
            }
            const blocks = liveBlocksRef.current
            const textContent = blocks.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text').map((b) => b.content).join('')
            if (!textContent && blocks.length === 0) return prev
            return [...prev, { id: `assistant-${Date.now()}`, threadId: activeThreadRef.current?.id ?? '', role: 'assistant', content: textContent, createdAt: new Date().toISOString(), metadata: blocks.length > 0 ? { contentBlocks: blocks } : undefined }]
          })
          void loadThreadsRef.current?.()
          cancelRequestedRef.current = false
          resetLiveState()
          break
        }
        case 'action': {
          try {
            const payload = event.data as ActionLoopResult
            if (payload.kind !== 'action' || !currentWorkspace || !activeThreadRef.current) break
            appendFrontendDebugLog('chat', 'stream_action_received', {
              requestId,
              executionId: payload.executionId,
              rawActionKind: typeof (payload as { action?: { kind?: unknown } }).action?.kind === 'string'
                ? (payload as { action?: { kind?: string } }).action?.kind
                : null,
            })
            setIsThinking(false)
            setIsStreaming(false)
            activeRequestIdRef.current = null
            replaceActiveExecutionId(payload.executionId ?? activeExecutionIdRef.current)
            replaceActivePlan(payload.plan ?? null)

            const normalizedAction = normalizeDesktopWorkspaceAction(payload.action)
            if (!normalizedAction) {
              appendFrontendDebugLog('chat', 'stream_action_invalid', {
                requestId,
                executionId: payload.executionId,
                payload: payload.action as Record<string, unknown> | undefined,
              })
              setError('Received an invalid local action from the controller.')
              replaceLiveBlocks((prev) => [
                ...prev,
                { type: 'text', content: 'The controller returned a malformed local action, so I could not continue this step automatically.' },
              ])
              persistExecutionSession()
              break
            }

            if (isImmediateWorkspaceAction(normalizedAction)) {
              const toolBlock = buildAgentActionToolBlock(normalizedAction)
              replaceLiveBlocks((prev) => [...prev, toolBlock])
              void runWorkspaceAction({
                action: normalizedAction,
                toolBlockId: toolBlock.id,
                threadId: activeThreadRef.current.id,
              }).then((completion) => {
                if (cancelRequestedRef.current) return
                return runAgentLocalActionTurn({
                  threadId: activeThreadRef.current!.id,
                  actionResult: { kind: normalizedAction.kind, ok: completion.ok, summary: completion.actionResultSummary, details: completion.actionResultDetails },
                  engineOverride: activeExecutionEngineRef.current,
                })
              })
              break
            }

            if (!isApprovalRequiredAction(normalizedAction)) {
              appendFrontendDebugLog('chat', 'stream_action_unsupported', {
                requestId,
                executionId: payload.executionId,
                kind: normalizedAction.kind,
              })
              setError(`Unsupported local action kind received: ${normalizedAction.kind}`)
              persistExecutionSession()
              break
            }

            const actionId = crypto.randomUUID()
            pendingLocalActionRef.current = {
              id: actionId,
              threadId: activeThreadRef.current.id,
              workspaceName: currentWorkspace.name,
              workspacePath: currentWorkspace.path,
              action: normalizedAction,
              source: 'agent',
              engine: activeExecutionEngineRef.current,
              status: 'pending',
            }
            persistExecutionSession()
            appendFrontendDebugLog('chat', 'approval_requested', {
              requestId,
              executionId: payload.executionId,
              actionKind: normalizedAction.kind,
            })

            replaceLiveBlocks((prev) => [
              ...prev,
              buildApprovalBlock(actionId, normalizedAction, currentWorkspace.path),
            ])
          } catch (error) {
            appendFrontendDebugLog('chat', 'stream_action_handler_failed', {
              requestId,
              error: error instanceof Error ? error.message : 'Failed to handle local action request',
            })
            setError(error instanceof Error ? error.message : 'Failed to handle local action request')
            persistExecutionSession()
          }
          break
        }
        default:
          break
      }
    })
    const stallTimeoutId = window.setInterval(() => {
      if (!isStreamingRef.current) return
      const lastEventAge = Date.now() - lastEventTimestampRef.current
      if (lastEventAge > 45_000) {
        void recoverStreamingExecution().then((recovered) => {
          if (!recovered) {
            setError('The connection timed out. Please try again.')
            resetLiveState()
          }
        })
      }
    }, 10_000)
    return () => {
      unsubscribe()
      window.clearInterval(stallTimeoutId)
    }
  }, [applyLiveLedgerEvent, currentWorkspace, persistExecutionSession, recoverStreamingExecution, replaceActiveExecutionId, replaceActivePlan, replaceLiveBlocks, resetLiveState, runAgentLocalActionTurn, runWorkspaceAction])

  const loadOlderMessages = useCallback(async () => {
    const threadId = activeThreadRef.current?.id
    if (!token || !threadId || isLoadingOlderMessages || !threadPagination.hasMoreOlder) return

    const beforeMessageId = threadPagination.nextBeforeMessageId ?? messages[0]?.id
    if (!beforeMessageId) return

    const requestVersion = activeThreadLoadVersionRef.current
    setIsLoadingOlderMessages(true)

    try {
      const res = await window.desktopAPI.threads.get(token, threadId, {
        limit: OLDER_THREAD_MESSAGE_LIMIT,
        beforeMessageId,
      })

      if (!res.success || !res.data) {
        throw new Error('Failed to load older messages')
      }

      if (activeThreadLoadVersionRef.current !== requestVersion || activeThreadRef.current?.id !== threadId) {
        return
      }

      const data = res.data as ThreadMessagesPage
      const hydratedMessages = await hydrateMessagesWithExecutionEvents(data.messages)
      setMessages((prev) => prependDistinctMessages(hydratedMessages, prev))
      setThreadPagination(data.pagination)
    } catch {
      setError('Failed to load older messages')
    } finally {
      if (activeThreadLoadVersionRef.current === requestVersion && activeThreadRef.current?.id === threadId) {
        setIsLoadingOlderMessages(false)
      }
    }
  }, [isLoadingOlderMessages, messages, threadPagination.hasMoreOlder, threadPagination.nextBeforeMessageId, token])

  const createThread = useCallback(async (): Promise<string | null> => {
    if (!token || !currentWorkspace) return null
    try {
      const res = await window.desktopAPI.threads.create(token, { preferredEngine: selectedEngineRef.current })
      if (res.success && res.data) {
        const newThread = res.data as Thread
        bindThreadToCurrentWorkspace(newThread.id)
        setAllThreads((prev) => [newThread, ...prev])
        setActiveThread(newThread)
        setMessages([])
        setThreadPagination({
          hasMoreOlder: false,
          nextBeforeMessageId: null,
          limit: INITIAL_THREAD_MESSAGE_LIMIT,
        })
        setIsThreadLoading(false)
        setIsLoadingOlderMessages(false)
        replaceActivePlan(null)
        replaceSelectedEngine(newThread.preferredEngine ?? selectedEngineRef.current)
        return newThread.id
      }
      return null
    } catch {
      setError('Failed to create thread')
      return null
    }
  }, [token, currentWorkspace, bindThreadToCurrentWorkspace, replaceActivePlan, replaceSelectedEngine])

  const setSelectedEngine = useCallback(async (engine: 'mastra' | 'langgraph') => {
    replaceSelectedEngine(engine)
    if (!token || !activeThreadRef.current) {
      return
    }

    setAllThreads((prev) =>
      prev.map((thread) =>
        thread.id === activeThreadRef.current?.id
          ? { ...thread, preferredEngine: engine }
          : thread,
      ),
    )
    setActiveThread((prev) => (prev ? { ...prev, preferredEngine: engine } : prev))

    try {
      await window.desktopAPI.threads.updatePreferences(token, activeThreadRef.current.id, {
        preferredEngine: engine,
      })
    } catch {
      setError('Failed to save engine preference')
    }
  }, [token, replaceSelectedEngine])

  const sendMessage = useCallback(async (
    text: string,
    attachedFiles?: Array<{ fileAssetId: string; cloudinaryUrl: string; mimeType: string; fileName: string }>,
    mode: 'fast' | 'high' | 'xtreme' = 'xtreme'
  ) => {
    if (!token || !currentWorkspace || !activeThread || isStreaming) return
    const trimmedText = text.trim()
    cancelRequestedRef.current = false
    activeModeRef.current = mode

    if (!trimmedText && (!attachedFiles || attachedFiles.length === 0)) return

    const userMsg: Message = { 
      id: `temp-${Date.now()}`, 
      threadId: activeThread.id, 
      role: 'user', 
      content: trimmedText, 
      metadata: attachedFiles && attachedFiles.length > 0 ? { attachedFiles } : undefined,
      createdAt: new Date().toISOString() 
    }
    setMessages((prev) => [...prev, userMsg])
    setIsStreaming(true)
    setIsThinking(true)
    replaceActivePlan(null)
    liveThinkingStartedAtRef.current = Date.now()
    liveExecutionEventsRef.current = []
    setLiveBlocks([{ type: 'thinking' }])
    liveBlocksRef.current = [{ type: 'thinking' }]
    setError(null)

    const runMatch = trimmedText.match(/^\/run\s+([\s\S]+)$/i)
    if (runMatch) {
      const command = runMatch[1].trim()
      try { await window.desktopAPI.threads.addMessage(token, activeThread.id, { role: 'user', content: trimmedText }) } catch { setError('Failed to save the command request.') }
      const executionId = crypto.randomUUID()
      pendingLocalActionRef.current = { id: executionId, threadId: activeThread.id, workspaceName: currentWorkspace.name, workspacePath: currentWorkspace.path, action: { kind: 'run_command', command }, source: 'manual', engine: selectedEngineRef.current }
      const approvalBlock = buildApprovalBlock(executionId, { kind: 'run_command', command }, currentWorkspace.path)
      setLiveBlocks([approvalBlock])
      liveBlocksRef.current = [approvalBlock]
      return
    }

    if (isLikelyLocalWorkspaceIntent(trimmedText)) {
      await runAgentLocalActionTurn({ threadId: activeThread.id, initialMessage: trimmedText, engineOverride: selectedEngineRef.current })
      return
    }

    try {
      const requestId = crypto.randomUUID()
      activeRequestIdRef.current = requestId
      replaceActiveExecutionId(requestId)
      activeExecutionEngineRef.current = selectedEngineRef.current
      ensureStreamingThinkingBlock()
      const sendRes = await window.desktopAPI.chat.startStream(
        token,
        activeThread.id,
        trimmedText,
        requestId,
        attachedFiles,
        mode,
        selectedEngineRef.current,
        { name: currentWorkspace.name, path: currentWorkspace.path },
      )
      if (!sendRes.success) {
        setError('Failed to send message')
        setIsStreaming(false)
        setIsThinking(false)
        activeRequestIdRef.current = null
        replaceActiveExecutionId(null)
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setError('Stream failed. Please try again.')
      setIsStreaming(false)
      setIsThinking(false)
      activeRequestIdRef.current = null
      replaceActiveExecutionId(null)
    }
  }, [token, currentWorkspace, activeThread, isStreaming, replaceActiveExecutionId, replaceActivePlan, runAgentLocalActionTurn, ensureStreamingThinkingBlock])

  const sendInitialMessage = useCallback(async (
    text: string,
    attachedFiles?: Array<{ fileAssetId: string; cloudinaryUrl: string; mimeType: string; fileName: string }>,
    mode: 'fast' | 'high' | 'xtreme' = 'xtreme'
  ) => {
    if (!token || !currentWorkspace || isStreaming) return
    const trimmedText = text.trim()
    cancelRequestedRef.current = false
    activeModeRef.current = mode

    if (!trimmedText && (!attachedFiles || attachedFiles.length === 0)) return

    try {
      const res = await window.desktopAPI.threads.create(token, { preferredEngine: selectedEngineRef.current })
      if (res.success && res.data) {
        const newThread = res.data as Thread
        bindThreadToCurrentWorkspace(newThread.id)
        setAllThreads((prev) => [newThread, ...prev])
        setActiveThread(newThread)
        setMessages([])
        setThreadPagination({
          hasMoreOlder: false,
          nextBeforeMessageId: null,
          limit: INITIAL_THREAD_MESSAGE_LIMIT,
        })
        setIsThreadLoading(false)
        setIsLoadingOlderMessages(false)
        replaceActivePlan(null)

        const userMsg: Message = { 
          id: `temp-${Date.now()}`, 
          threadId: newThread.id, 
          role: 'user', 
          content: trimmedText, 
          metadata: attachedFiles && attachedFiles.length > 0 ? { attachedFiles } : undefined,
          createdAt: new Date().toISOString() 
        }

        setMessages([userMsg])
        setIsStreaming(true)
        setIsThinking(true)
        liveThinkingStartedAtRef.current = Date.now()
        liveExecutionEventsRef.current = []
        setLiveBlocks([{ type: 'thinking' }])
        liveBlocksRef.current = [{ type: 'thinking' }]
        setError(null)

        const requestId = crypto.randomUUID()
        activeRequestIdRef.current = requestId
        activeExecutionEngineRef.current = selectedEngineRef.current
        
        if (typeof window.desktopAPI.chat.sendMessageStream !== 'function') {
          console.error('[CRITICAL] window.desktopAPI.chat.sendMessageStream is not defined. The desktop app needs a full restart to load new preload scripts.')
          setError('Application architecture changed. Please restart the desktop app to send messages.')
          setIsStreaming(false)
          setMessages([])
          return
        }

        const streamResult = await window.desktopAPI.chat.sendMessageStream({
          token,
          requestId,
          threadId: newThread.id,
          message: trimmedText,
          attachedFiles,
          mode,
          engine: selectedEngineRef.current,
          workspace: { name: currentWorkspace.name, path: currentWorkspace.path },
          companyId: currentWorkspace.id,
        })

        if (!streamResult.success) {
          setError(streamResult.error ?? 'Failed to send message')
          setIsStreaming(false)
          setMessages([]) // Rollback optimistic update
          return
        }
      }
    } catch (error) {
      console.error('Failed to create thread and send message:', error)
      setError('Failed to create thread and send message')
    }
  }, [token, currentWorkspace, isStreaming, bindThreadToCurrentWorkspace, replaceActivePlan])

  const stopExecution = useCallback(async () => {
    cancelRequestedRef.current = true

    const requestId = activeRequestIdRef.current
    if (requestId) {
      await window.desktopAPI.chat.stopStream(requestId).catch(() => undefined)
    }

    const runningCommand = runningCommandRef.current
    if (runningCommand) {
      await window.desktopAPI.terminal.kill(runningCommand.id).catch(() => undefined)
    }

    commitPartialAssistant()
    resetLiveState()
  }, [commitPartialAssistant, resetLiveState])

  const clearError = useCallback(() => setError(null), [])

  const deleteThread = useCallback(async (threadId: string) => {
    if (!token) return
    try {
      const result = await window.desktopAPI.threads.delete(token, threadId)
      if (!result?.success) { setError('Failed to delete thread'); return }
      unbindThread(threadId)
      setAllThreads((prev) => prev.filter((thread) => thread.id !== threadId))
      if (activeThreadRef.current?.id === threadId) {
        setActiveThread(null)
        setMessages([])
        setThreadPagination({
          hasMoreOlder: false,
          nextBeforeMessageId: null,
          limit: INITIAL_THREAD_MESSAGE_LIMIT,
        })
        setIsThreadLoading(false)
        setIsLoadingOlderMessages(false)
        replaceActivePlan(null)
      }
    } catch {
      setError('Failed to delete thread — please restart the app and try again')
    }
  }, [token, replaceActivePlan, unbindThread])

  return (
    <ChatContext.Provider value={{
      threads,
      activeThread,
      messages,
      isThreadLoading,
      isLoadingOlderMessages,
      hasMoreHistory: threadPagination.hasMoreOlder,
      isStreaming,
      isThinking,
      activePlan,
      liveBlocks,
      selectedEngine,
      error,
      loadThreads,
      selectThread,
      loadOlderMessages,
      createThread,
      deleteThread,
      setSelectedEngine,
      sendMessage,
      sendInitialMessage,
      stopExecution,
      approveCommand,
      rejectCommand,
      killCommand,
      clearError,
    }}>
      {children}
    </ChatContext.Provider>
  )
}

export function useChat(): ChatState {
  const ctx = useContext(ChatContext)
  if (!ctx) throw new Error('useChat must be used within ChatProvider')
  return ctx
}
