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
  ThreadMessagesPage,
  ThreadMessagePagination,
} from '../types'
import { useAuth } from './AuthContext'
import { useWorkspace } from './WorkspaceContext'
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
} from '../lib/chat-helpers'
import { logFrontendDebug, logFrontendError } from '../lib/frontend-debug-log'

export type { DesktopWorkspaceAction, ActionResultPayload }

type WorkflowInvocation = {
  workflowId: string
  workflowName: string
  overrideText?: string
}

const isActivityFailure = (input: { label?: string; resultSummary?: string }): boolean => {
  const label = (input.label ?? '').toLowerCase()
  const summary = (input.resultSummary ?? '').toLowerCase()
  return (
    label.includes('failed')
    || label.includes('error')
    || summary === 'error'
    || summary.includes('failed')
    || summary.includes('error:')
    || summary.includes('not permitted')
  )
}

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
  autoApproveLocalActions: boolean
  activePlan: ExecutionPlan | null
  liveBlocks: ContentBlock[]
  pendingLocalAction: PendingLocalActionState | null
  error: string | null
  loadThreads: () => Promise<void>
  selectThread: (threadId: string) => Promise<void>
  loadOlderMessages: () => Promise<void>
  createThread: () => Promise<string | null>
  deleteThread: (threadId: string) => Promise<void>
  sendMessage: (
    text: string,
    attachedFiles?: Array<{ fileAssetId: string; cloudinaryUrl: string; mimeType: string; fileName: string }>,
    mode?: 'fast' | 'high' | 'xtreme',
    workflowInvocation?: WorkflowInvocation,
  ) => Promise<void>
  sendInitialMessage: (
    text: string,
    attachedFiles?: Array<{ fileAssetId: string; cloudinaryUrl: string; mimeType: string; fileName: string }>,
    mode?: 'fast' | 'high' | 'xtreme',
    workflowInvocation?: WorkflowInvocation,
  ) => Promise<void>
  stopExecution: () => Promise<void>
  approveCommand: (executionId: string) => Promise<void>
  rejectCommand: (executionId: string) => Promise<void>
  killCommand: (executionId: string) => Promise<void>
  setAutoApproveLocalActions: (enabled: boolean) => void
  clearError: () => void
}

const ChatContext = createContext<ChatState | null>(null)

const INITIAL_THREAD_MESSAGE_LIMIT = 6
const OLDER_THREAD_MESSAGE_LIMIT = 20
const AUTO_APPROVE_LOCAL_ACTIONS_KEY = 'cursorr_auto_approve_local_actions'

const prependDistinctMessages = (older: Message[], current: Message[]): Message[] => {
  if (older.length === 0) {
    return current
  }

  const seen = new Set(current.map((message) => message.id))
  const uniqueOlder = older.filter((message) => !seen.has(message.id))
  return uniqueOlder.length > 0 ? [...uniqueOlder, ...current] : current
}

// ── Provider ──────────────────────────────────────────────────────────────────

export function ChatProvider({ children }: { children: ReactNode }): JSX.Element {
  const { token, session, selectedDepartmentId, setSelectedDepartmentId } = useAuth()
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
  const [autoApproveLocalActions, setAutoApproveLocalActionsState] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return window.localStorage.getItem(AUTO_APPROVE_LOCAL_ACTIONS_KEY) === 'true'
  })
  const [activePlan, setActivePlan] = useState<ExecutionPlan | null>(null)
  const [liveBlocks, setLiveBlocks] = useState<ContentBlock[]>([])
  const [pendingLocalAction, setPendingLocalAction] = useState<PendingLocalActionState | null>(null)
  const [error, setError] = useState<string | null>(null)

  // ── Refs for mutable cross-callback access ──
  const activeRequestIdRef = useRef<string | null>(null)
  const activeThreadRef = useRef<Thread | null>(null)
  const activeThreadLoadVersionRef = useRef(0)
  const activePlanRef = useRef<ExecutionPlan | null>(null)
  const activeExecutionIdRef = useRef<string | null>(null)
  const liveBlocksRef = useRef<ContentBlock[]>([])
  const loadThreadsRef = useRef<(() => Promise<void>) | null>(null)
  const pendingLocalActionRef = useRef<PendingLocalActionState | null>(null)
  const runningCommandRef = useRef<RunningCommandState | null>(null)
  const approveCommandRef = useRef<((executionId: string) => Promise<void>) | null>(null)
  const cancelRequestedRef = useRef(false)
  const activeModeRef = useRef<'fast' | 'high' | 'xtreme'>('xtreme')
  const autoApproveLocalActionsRef = useRef(autoApproveLocalActions)

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

  const replaceActiveExecutionId = useCallback((executionId: string | null) => {
    activeExecutionIdRef.current = executionId
  }, [])

  useEffect(() => {
    autoApproveLocalActionsRef.current = autoApproveLocalActions
    window.localStorage.setItem(AUTO_APPROVE_LOCAL_ACTIONS_KEY, autoApproveLocalActions ? 'true' : 'false')
  }, [autoApproveLocalActions])

  const setAutoApproveLocalActions = useCallback((enabled: boolean) => {
    setAutoApproveLocalActionsState(enabled)
  }, [])

  const resetLiveState = useCallback(() => {
    setLiveBlocks([])
    liveBlocksRef.current = []
    setIsStreaming(false)
    setIsThinking(false)
    replaceActivePlan(null)
    replaceActiveExecutionId(null)
    activeRequestIdRef.current = null
    pendingLocalActionRef.current = null
    setPendingLocalAction(null)
    runningCommandRef.current = null
  }, [replaceActiveExecutionId, replaceActivePlan])

  const finishPendingApprovalStream = useCallback(() => {
    setLiveBlocks([])
    liveBlocksRef.current = []
    setIsStreaming(false)
    setIsThinking(false)
    activeRequestIdRef.current = null
    runningCommandRef.current = null
  }, [])

  const archiveLiveBlocksForContinuation = useCallback(async (input: {
    threadId: string
    summaryContent?: string
    summaryMetadata?: MessageMetadata
  }) => {
    const finalizedBlocks = liveBlocksRef.current
    const metadata: MessageMetadata | undefined = finalizedBlocks.length > 0 || input.summaryMetadata
      ? {
        ...(input.summaryMetadata ?? {}),
        ...(finalizedBlocks.length > 0 ? { contentBlocks: finalizedBlocks } : {}),
      }
      : undefined

    let persistedMessage: Message | null = null
    if (token && (finalizedBlocks.length > 0 || input.summaryContent)) {
      try {
        const response = await window.desktopAPI.threads.addMessage(token, input.threadId, {
          role: 'assistant',
          content: input.summaryContent ?? '',
          metadata: metadata as Record<string, unknown> | undefined,
        })
        persistedMessage = (response.data as Message | undefined) ?? null
      } catch {
        setError('Local action finished, but saving the execution card failed.')
      }
    }

    if (persistedMessage) {
      setMessages((prev) => [...prev, persistedMessage!])
    } else if (finalizedBlocks.length > 0) {
      setMessages((prev) => [
        ...prev,
        {
          id: `assistant-local-turn-${Date.now()}`,
          threadId: input.threadId,
          role: 'assistant',
          content: input.summaryContent ?? '',
          createdAt: new Date().toISOString(),
          metadata,
        },
      ])
    }
    setLiveBlocks([])
    liveBlocksRef.current = []
    setIsThinking(false)
  }, [token])

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

  const persistExecutionEvent = useCallback(async (input: {
    executionId: string
    phase: 'request' | 'planning' | 'tool' | 'synthesis' | 'delivery' | 'error' | 'control'
    eventType: string
    actorType: 'system' | 'planner' | 'agent' | 'tool' | 'model' | 'delivery'
    actorKey?: string
    title: string
    summary?: string
    status?: string
    payload?: Record<string, unknown>
  }) => {
    if (!token) return
    try {
      await window.desktopAPI.fetch(`/api/desktop/executions/${input.executionId}/events`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(input),
      })
    } catch {
      // non-fatal; runtime should continue even if client-side event mirroring fails
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

    return completion
  }, [currentWorkspace, replaceLiveBlocks])

  // ── Run one agentic action loop turn ──
  const runAgentLocalActionTurn = useCallback(async (input: {
    threadId: string
    initialMessage?: string
    actionResult?: ActionResultPayload
  }): Promise<void> => {
    if (!token) return
    if (typeof window.desktopAPI.chat.actStream !== 'function') {
      setError('Workspace tools are not loaded in this desktop session. Restart the Electron app to enable file and terminal actions.')
      resetLiveState()
      return
    }

    const requestId = crypto.randomUUID()
    const executionId = activeExecutionIdRef.current ?? requestId
    activeRequestIdRef.current = requestId
    replaceActiveExecutionId(executionId)
    setIsStreaming(true)
    setIsThinking(true)
    replaceLiveBlocks((prev) => {
      const last = prev[prev.length - 1]
      if (last?.type === 'thinking') return prev
      return [...prev, { type: 'thinking', text: '' }]
    })
    logFrontendDebug('agent.local_action.turn.start', {
      threadId: input.threadId,
      hasInitialMessage: Boolean(input.initialMessage),
      actionKind: input.actionResult?.kind ?? null,
      executionId,
      requestId,
    })

    try {
      const response = await window.desktopAPI.chat.actStream(token, input.threadId, requestId, {
        message: input.initialMessage,
        ...(currentWorkspace ? { workspace: { name: currentWorkspace.name, path: currentWorkspace.path } } : {}),
        actionResult: input.actionResult,
        ...(activePlanRef.current ? { plan: activePlanRef.current } : {}),
        mode: activeModeRef.current,
        executionId,
      })

      if (!response.success) throw new Error(response.message || 'Desktop action loop failed')
      if (cancelRequestedRef.current) return
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Desktop action loop failed'
      logFrontendError('agent.local_action.turn.failed', err, {
        threadId: input.threadId,
        executionId,
        actionKind: input.actionResult?.kind ?? null,
      })
      setError(message)
      setIsStreaming(false)
      setIsThinking(false)
      if (liveBlocksRef.current.length === 0) {
        resetLiveState()
      }
    }
  }, [currentWorkspace, replaceActiveExecutionId, replaceLiveBlocks, resetLiveState, token])

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

    runningCommandRef.current = null
    logFrontendDebug('terminal.command.finished', {
      executionId: input.executionId,
      threadId: runningCommand.threadId,
      status: input.status,
      exitCode: input.exitCode ?? null,
      source: runningCommand.source,
    })

    if (runningCommand.source === 'agent') {
      if (cancelRequestedRef.current) return
      await archiveLiveBlocksForContinuation({
        threadId: runningCommand.threadId,
        summaryContent: completion.summaryContent,
        summaryMetadata: completion.summaryMetadata,
      })
      await runAgentLocalActionTurn({
        threadId: runningCommand.threadId,
        actionResult: { kind: 'run_command', ok: completion.ok, summary: completion.actionResultSummary },
      })
      return
    }

    await persistLocalSummary({ threadId: runningCommand.threadId, content: completion.summaryContent, metadata: completion.summaryMetadata })
    await finalizeLocalBlocks({ threadId: runningCommand.threadId })
  }, [archiveLiveBlocksForContinuation, finalizeLocalBlocks, persistLocalSummary, replaceActivePlan, runAgentLocalActionTurn])

  // ── SSE stream event subscriber ──
  useEffect(() => {
    const unsubscribe = window.desktopAPI.chat.onStreamEvent(({ requestId, event }) => {
      if (activeRequestIdRef.current !== requestId) return

      switch (event.type) {
        case 'plan':
          replaceActivePlan((event.data as ExecutionPlan | null) ?? null)
          break
        case 'thinking_token': {
          const delta = String(event.data ?? '')
          if (!delta) break
          replaceLiveBlocks((prev) => {
            const last = prev[prev.length - 1]
            if (last?.type !== 'thinking') return prev
            return [...prev.slice(0, -1), { ...last, text: ((last as Extract<ContentBlock, { type: 'thinking' }>).text || '') + delta }]
          })
          break
        }
        case 'thinking':
          setIsThinking(true)
          replaceLiveBlocks((prev) => {
            const last = prev[prev.length - 1]
            if (last?.type === 'thinking') return prev
            return [...prev, { type: 'thinking' }]
          })
          break
        case 'activity': {
          const raw = event.data as { id: string; name: string; label: string; icon: string }
          setIsThinking(false)
          replaceLiveBlocks((prev) => [...prev, { type: 'tool', id: raw.id ?? String(Date.now()), name: raw.name ?? '', label: raw.label ?? raw.name ?? 'Working...', icon: raw.icon ?? 'zap', status: 'running' }])
          break
        }
        case 'activity_done': {
          const raw = event.data as { id: string; label?: string; icon?: string; name?: string; resultSummary?: string }
          const ok = !isActivityFailure(raw)
          replaceLiveBlocks((prev) =>
            prev.map((block) =>
              block.type === 'tool' && block.id === raw.id
                ? { ...block, name: raw.name ?? block.name, label: raw.label ?? block.label, icon: raw.icon ?? block.icon, status: ok ? 'done' as const : 'failed' as const, resultSummary: raw.resultSummary }
                : block,
            ),
          )
          break
        }
        case 'action': {
          const raw = event.data as { action?: DesktopWorkspaceAction; executionId?: string } | null
          const action = raw?.action
          const threadId = activeThreadRef.current?.id
          if (!action || !threadId) break
          setIsThinking(false)

          const actionId = raw?.executionId ?? crypto.randomUUID()
          pendingLocalActionRef.current = {
            id: actionId,
            threadId,
            workspaceName: currentWorkspace?.name ?? 'Remote action',
            workspacePath: currentWorkspace?.path ?? '',
            action,
            source: 'agent',
          }
          setPendingLocalAction(pendingLocalActionRef.current)
          if (autoApproveLocalActionsRef.current && action.kind !== 'list_files' && action.kind !== 'read_file') {
            queueMicrotask(() => {
              void approveCommandRef.current?.(actionId)
            })
          }
          break
        }
        case 'text': {
          const chunk = String(event.data ?? '')
          setIsThinking(false)
          replaceLiveBlocks((prev) => {
            const last = prev[prev.length - 1]
            if (last?.type === 'text') return [...prev.slice(0, -1), { type: 'text', content: last.content + chunk }]
            return [...prev, { type: 'text', content: chunk }]
          })
          break
        }
        case 'error':
          if (cancelRequestedRef.current) {
            cancelRequestedRef.current = false
            resetLiveState()
            break
          }
          setError(String(event.data ?? 'Stream failed. Please try again.'))
          resetLiveState()
          break
        case 'done': {
          const raw = event.data as { message?: Message; actionIssued?: boolean } | null
          const persistedMessage = raw?.message
          setMessages((prev) => {
            if (persistedMessage) return [...prev, persistedMessage]
            const blocks = liveBlocksRef.current
            const textContent = blocks.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text').map((b) => b.content).join('')
            if (!textContent && blocks.length === 0) return prev
            return [...prev, { id: `assistant-${Date.now()}`, threadId: activeThreadRef.current?.id ?? '', role: 'assistant', content: textContent, createdAt: new Date().toISOString(), metadata: blocks.length > 0 ? { contentBlocks: blocks } : undefined }]
          })
          void loadThreadsRef.current?.()
          cancelRequestedRef.current = false
          if (raw?.actionIssued) {
            finishPendingApprovalStream()
          } else {
            resetLiveState()
          }
          break
        }
        default:
          break
      }
    })
    return unsubscribe
  }, [currentWorkspace, finishPendingApprovalStream, replaceActiveExecutionId, replaceActivePlan, replaceLiveBlocks, resetLiveState])

  // ── Terminal event subscriber ──
  useEffect(() => {
    const unsubscribe = window.desktopAPI.terminal.onEvent(({ executionId, event }) => {
      const runningCommand = runningCommandRef.current
      if (!runningCommand || runningCommand.id !== executionId) return

      switch (event.type) {
        case 'stdout': {
          const chunk = String(event.data ?? '')
          replaceLiveBlocks((prev) => prev.map((block) => block.type === 'terminal' && block.id === executionId ? { ...block, stdout: appendOutput(block.stdout, chunk) } : block))
          void persistExecutionEvent({
            executionId,
            phase: 'control',
            eventType: 'terminal.stdout',
            actorType: 'tool',
            actorKey: 'terminal',
            title: 'Terminal stdout',
            summary: chunk.slice(0, 1000),
            status: 'running',
            payload: { chunk },
          })
          break
        }
        case 'stderr': {
          const chunk = String(event.data ?? '')
          replaceLiveBlocks((prev) => prev.map((block) => block.type === 'terminal' && block.id === executionId ? { ...block, stderr: appendOutput(block.stderr, chunk) } : block))
          void persistExecutionEvent({
            executionId,
            phase: 'control',
            eventType: 'terminal.stderr',
            actorType: 'tool',
            actorKey: 'terminal',
            title: 'Terminal stderr',
            summary: chunk.slice(0, 1000),
            status: 'running',
            payload: { chunk },
          })
          break
        }
        case 'error': {
          const raw = event.data as { message?: string; durationMs?: number }
          replaceLiveBlocks((prev) => prev.map((block) => block.type === 'terminal' && block.id === executionId ? { ...block, status: 'failed', stderr: appendOutput(block.stderr, `${raw.message ?? 'Execution failed'}\n`), durationMs: raw.durationMs } : block))
          void persistExecutionEvent({
            executionId,
            phase: 'control',
            eventType: 'terminal.failed',
            actorType: 'tool',
            actorKey: 'terminal',
            title: 'Terminal execution failed',
            summary: raw.message ?? 'Execution failed',
            status: 'failed',
            payload: { durationMs: raw.durationMs ?? null },
          })
          void finishCommandExecution({ executionId, status: 'failed', durationMs: raw.durationMs })
          break
        }
        case 'exit': {
          const raw = event.data as { exitCode?: number | null; signal?: string | null; durationMs?: number }
          const terminalStatus: 'done' | 'failed' = raw.exitCode === 0 ? 'done' : 'failed'
          replaceLiveBlocks((prev) => prev.map((block) => block.type === 'terminal' && block.id === executionId ? { ...block, status: terminalStatus, exitCode: raw.exitCode ?? null, signal: raw.signal ?? null, durationMs: raw.durationMs } : block))
          void persistExecutionEvent({
            executionId,
            phase: 'control',
            eventType: terminalStatus === 'done' ? 'terminal.completed' : 'terminal.failed',
            actorType: 'tool',
            actorKey: 'terminal',
            title: terminalStatus === 'done' ? 'Terminal execution completed' : 'Terminal execution failed',
            summary: `Exit code ${raw.exitCode ?? 'unknown'}`,
            status: terminalStatus,
            payload: {
              exitCode: raw.exitCode ?? null,
              signal: raw.signal ?? null,
              durationMs: raw.durationMs ?? null,
            },
          })
          void finishCommandExecution({ executionId, status: terminalStatus, exitCode: raw.exitCode ?? null, signal: raw.signal ?? null, durationMs: raw.durationMs })
          break
        }
        default:
          break
      }
    })
    return unsubscribe
  }, [appendOutput, finishCommandExecution, persistExecutionEvent, replaceLiveBlocks])

  useEffect(() => { activeThreadRef.current = activeThread }, [activeThread])

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
    }
  }, [currentWorkspace, isThreadInCurrentWorkspace, replaceActivePlan])

  const threads = currentWorkspace ? allThreads.filter((thread) => isThreadInCurrentWorkspace(thread.id)) : []

  // ── Approval handlers ──
  const approveCommand = useCallback(async (executionId: string) => {
    const pendingAction = pendingLocalActionRef.current
    if (!pendingAction || pendingAction.id !== executionId) return

    pendingLocalActionRef.current = null
    setPendingLocalAction(null)
    void persistExecutionEvent({
      executionId,
      phase: 'control',
      eventType: 'control.approved',
      actorType: 'system',
      actorKey: pendingAction.action.kind,
      title: `${pendingAction.action.kind} approval approved`,
      summary: pendingAction.action.kind === 'run_command'
        ? pendingAction.action.command
        : pendingAction.action.kind === 'tool_action'
          ? pendingAction.action.summary
          : pendingAction.action.path,
      status: 'done',
      payload: { cwd: pendingAction.workspacePath },
    })

    if (pendingAction.action.kind === 'tool_action') {
      const result = await window.desktopAPI.chat.resolveHitlAction(
        token!,
        pendingAction.threadId,
        pendingAction.action.approvalId,
        'confirmed',
      )
      if (!result.success) {
        setError(result.message ?? 'Failed to execute approved action')
        return
      }
      const actionResult = ((result.data as { data?: ActionResultPayload } | undefined)?.data ?? result.data) as ActionResultPayload | undefined
      if (!actionResult) {
        setError('Approved action completed but no result was returned')
        return
      }
      await runAgentLocalActionTurn({
        threadId: pendingAction.threadId,
        actionResult,
      })
      return
    }

    if (pendingAction.action.kind === 'run_command') {
      const command = pendingAction.action.command
      logFrontendDebug('approval.command.approved', {
        executionId,
        threadId: pendingAction.threadId,
        command,
      })
      runningCommandRef.current = { id: executionId, threadId: pendingAction.threadId, workspaceName: pendingAction.workspaceName, cwd: pendingAction.workspacePath, command, source: pendingAction.source }
      replaceLiveBlocks((prev) => [...prev, { type: 'terminal', id: executionId, command, cwd: pendingAction.workspacePath, status: 'running', stdout: '', stderr: '' }])
      void persistExecutionEvent({
        executionId,
        phase: 'control',
        eventType: 'terminal.started',
        actorType: 'tool',
        actorKey: 'terminal',
        title: 'Terminal execution started',
        summary: command,
        status: 'running',
        payload: { cwd: pendingAction.workspacePath },
      })
      const result = await window.desktopAPI.terminal.exec(executionId, command, pendingAction.workspacePath)
      if (!result.success) {
        logFrontendError('approval.command.exec_failed', result.error ?? 'Execution failed', {
          executionId,
          threadId: pendingAction.threadId,
        })
        replaceLiveBlocks((prev) => prev.map((block) => block.type === 'terminal' && block.id === executionId ? { ...block, status: 'failed', stderr: appendOutput(block.stderr, `${result.error ?? 'Execution failed'}\n`) } : block))
        await finishCommandExecution({ executionId, status: 'failed' })
      }
      return
    }

    const toolBlock = buildAgentActionToolBlock(pendingAction.action)
    replaceLiveBlocks((prev) => [...prev, toolBlock])
    const completion = await runWorkspaceAction({ action: pendingAction.action as NonCommandWorkspaceAction, toolBlockId: toolBlock.id, threadId: pendingAction.threadId })

    if (pendingAction.source === 'agent') {
      await archiveLiveBlocksForContinuation({
        threadId: pendingAction.threadId,
        summaryContent: completion.summaryContent,
        summaryMetadata: completion.summaryMetadata,
      })
      await runAgentLocalActionTurn({ threadId: pendingAction.threadId, actionResult: { kind: pendingAction.action.kind, ok: completion.ok, summary: completion.actionResultSummary } })
      return
    }
    await finalizeLocalBlocks({
      threadId: pendingAction.threadId,
      summaryContent: completion.summaryContent,
      summaryMetadata: completion.summaryMetadata,
    })
  }, [appendOutput, archiveLiveBlocksForContinuation, finalizeLocalBlocks, finishCommandExecution, persistExecutionEvent, replaceActivePlan, replaceLiveBlocks, runAgentLocalActionTurn, runWorkspaceAction])

  useEffect(() => {
    approveCommandRef.current = approveCommand
  }, [approveCommand])

  const rejectCommand = useCallback(async (executionId: string) => {
    const pendingAction = pendingLocalActionRef.current
    if (!pendingAction || pendingAction.id !== executionId) return

    pendingLocalActionRef.current = null
    setPendingLocalAction(null)
    logFrontendDebug('approval.command.rejected', {
      executionId,
      threadId: pendingAction.threadId,
      actionKind: pendingAction.action.kind,
    })
    void persistExecutionEvent({
      executionId,
      phase: 'control',
      eventType: 'control.rejected',
      actorType: 'system',
      actorKey: pendingAction.action.kind,
      title: `${pendingAction.action.kind} approval rejected`,
      summary: pendingAction.action.kind === 'run_command'
        ? pendingAction.action.command
        : pendingAction.action.kind === 'tool_action'
          ? pendingAction.action.summary
          : pendingAction.action.path,
      status: 'failed',
      payload: { cwd: pendingAction.workspacePath },
    })

    if (pendingAction.action.kind === 'tool_action') {
      const result = await window.desktopAPI.chat.resolveHitlAction(
        token!,
        pendingAction.threadId,
        pendingAction.action.approvalId,
        'cancelled',
      )
      if (!result.success) {
        setError(result.message ?? 'Failed to reject action')
        return
      }
      const actionResult = ((result.data as { data?: ActionResultPayload } | undefined)?.data ?? result.data) as ActionResultPayload | undefined
      if (!actionResult) {
        setError('Rejected action completed but no result was returned')
        return
      }
      await runAgentLocalActionTurn({
        threadId: pendingAction.threadId,
        actionResult,
      })
      return
    }

    if (pendingAction.action.kind === 'run_command') {
      const completion = summarizeCommandCompletion({ command: pendingAction.action.command, cwd: pendingAction.workspacePath, status: 'rejected' })
      if (pendingAction.source === 'agent') {
        await persistLocalSummary({ threadId: pendingAction.threadId, content: completion.summaryContent, metadata: completion.summaryMetadata })
        await runAgentLocalActionTurn({ threadId: pendingAction.threadId, actionResult: { kind: 'run_command', ok: false, summary: completion.actionResultSummary } })
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
      await runAgentLocalActionTurn({ threadId: pendingAction.threadId, actionResult: { kind: fileAction.kind, ok: false, summary: `User rejected ${fileAction.kind} for ${fileAction.path}` } })
      return
    }
    await finalizeLocalBlocks({ threadId: pendingAction.threadId, summaryContent, summaryMetadata })
  }, [finalizeLocalBlocks, persistExecutionEvent, persistLocalSummary, replaceLiveBlocks, runAgentLocalActionTurn, token])

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
    if (!token || !currentWorkspace || !isThreadInCurrentWorkspace(threadId) || isStreaming) return
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
        setActiveThread(data.thread)
        if (data.thread.departmentId) {
          setSelectedDepartmentId(data.thread.departmentId)
        }
        setMessages(data.messages)
        setThreadPagination(data.pagination)
        replaceActivePlan(null)
        setError(null)
      }
    } catch {
      setError('Failed to load thread')
    } finally {
      if (activeThreadLoadVersionRef.current === requestVersion) {
        setIsThreadLoading(false)
      }
    }
  }, [allThreads, token, currentWorkspace, isThreadInCurrentWorkspace, isStreaming, replaceActivePlan, setSelectedDepartmentId])

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
      setMessages((prev) => prependDistinctMessages(data.messages, prev))
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
    if (!token || !currentWorkspace || isStreaming) return null
    if ((session?.departments?.length ?? 0) > 1 && !selectedDepartmentId) {
      setError('Select a department before starting a new chat.')
      return null
    }
    try {
      const res = await window.desktopAPI.threads.create(token, selectedDepartmentId ? { departmentId: selectedDepartmentId } : undefined)
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
        return newThread.id
      }
      return null
    } catch {
      setError('Failed to create thread')
      return null
    }
  }, [token, currentWorkspace, isStreaming, bindThreadToCurrentWorkspace, replaceActivePlan, selectedDepartmentId, session?.departments?.length])

  const sendMessage = useCallback(async (
    text: string,
    attachedFiles?: Array<{ fileAssetId: string; cloudinaryUrl: string; mimeType: string; fileName: string }>,
    mode: 'fast' | 'high' | 'xtreme' = 'xtreme',
    workflowInvocation?: WorkflowInvocation,
  ) => {
    if (!token || !currentWorkspace || !activeThread || isStreaming) return
    const trimmedText = text.trim()
    cancelRequestedRef.current = false
    activeModeRef.current = mode

    if (!trimmedText && (!attachedFiles || attachedFiles.length === 0) && !workflowInvocation) return

    const visibleUserText = trimmedText || (workflowInvocation
      ? workflowInvocation.overrideText?.trim()
        ? `Run workflow "${workflowInvocation.workflowName}" with a one-time override.`
        : `Run saved workflow "${workflowInvocation.workflowName}".`
      : '')

    const userMsg: Message = { 
      id: `temp-${Date.now()}`, 
      threadId: activeThread.id, 
      role: 'user', 
      content: visibleUserText, 
      metadata: attachedFiles && attachedFiles.length > 0 ? { attachedFiles } : undefined,
      createdAt: new Date().toISOString() 
    }
    setMessages((prev) => [...prev, userMsg])
    setIsStreaming(true)
    setIsThinking(false)
    replaceActivePlan(null)
    setLiveBlocks([])
    liveBlocksRef.current = []
    setError(null)

    const runMatch = trimmedText.match(/^\/run\s+([\s\S]+)$/i)
    if (runMatch) {
      const command = runMatch[1].trim()
      try { await window.desktopAPI.threads.addMessage(token, activeThread.id, { role: 'user', content: trimmedText }) } catch { setError('Failed to save the command request.') }
      const executionId = crypto.randomUUID()
      const nextPendingAction = { id: executionId, threadId: activeThread.id, workspaceName: currentWorkspace.name, workspacePath: currentWorkspace.path, action: { kind: 'run_command', command } as const, source: 'manual' as const }
      pendingLocalActionRef.current = nextPendingAction
      setPendingLocalAction(nextPendingAction)
      setIsStreaming(false)
      setIsThinking(false)
      replaceActiveExecutionId(null)
      return
    }

    try {
      const requestId = crypto.randomUUID()
      activeRequestIdRef.current = requestId
      replaceActiveExecutionId(requestId)
      const sendRes = await window.desktopAPI.chat.startStream(
        token,
        activeThread.id,
        trimmedText,
        requestId,
        attachedFiles,
        mode,
        { name: currentWorkspace.name, path: currentWorkspace.path },
        workflowInvocation,
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
  }, [token, currentWorkspace, activeThread, isStreaming, replaceActiveExecutionId, replaceActivePlan, runAgentLocalActionTurn])

  const sendInitialMessage = useCallback(async (
    text: string,
    attachedFiles?: Array<{ fileAssetId: string; cloudinaryUrl: string; mimeType: string; fileName: string }>,
    mode: 'fast' | 'high' | 'xtreme' = 'xtreme',
    workflowInvocation?: WorkflowInvocation,
  ) => {
    if (!token || !currentWorkspace || isStreaming) return
    if ((session?.departments?.length ?? 0) > 1 && !selectedDepartmentId) {
      setError('Select a department before starting a new chat.')
      return
    }
    const trimmedText = text.trim()
    cancelRequestedRef.current = false
    activeModeRef.current = mode

    if (!trimmedText && (!attachedFiles || attachedFiles.length === 0) && !workflowInvocation) return

    const visibleUserText = trimmedText || (workflowInvocation
      ? workflowInvocation.overrideText?.trim()
        ? `Run workflow "${workflowInvocation.workflowName}" with a one-time override.`
        : `Run saved workflow "${workflowInvocation.workflowName}".`
      : '')

    try {
      const res = await window.desktopAPI.threads.create(token, selectedDepartmentId ? { departmentId: selectedDepartmentId } : undefined)
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
          content: visibleUserText, 
          metadata: attachedFiles && attachedFiles.length > 0 ? { attachedFiles } : undefined,
          createdAt: new Date().toISOString() 
        }

        setMessages([userMsg])
        setIsStreaming(true)
        setIsThinking(false)
        setError(null)

        const requestId = crypto.randomUUID()
        activeRequestIdRef.current = requestId
        
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
          companyId: currentWorkspace.id,
          workspace: { name: currentWorkspace.name, path: currentWorkspace.path },
          workflowInvocation,
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
  }, [token, currentWorkspace, isStreaming, bindThreadToCurrentWorkspace, replaceActivePlan, selectedDepartmentId, session?.departments?.length])

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
    if (isStreaming) return
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
  }, [token, isStreaming, replaceActivePlan, unbindThread])

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
      autoApproveLocalActions,
      activePlan,
      liveBlocks,
      pendingLocalAction,
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
      setAutoApproveLocalActions,
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
