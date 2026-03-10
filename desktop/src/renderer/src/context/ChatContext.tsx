import {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  useEffect,
  type ReactNode,
} from 'react'
import type { Thread, Message, ContentBlock, MessageMetadata, ApprovalContentBlock } from '../types'
import { useAuth } from './AuthContext'
import { useWorkspace } from './WorkspaceContext'

type DesktopWorkspaceAction =
  | { kind: 'list_files'; path?: string }
  | { kind: 'read_file'; path: string }
  | { kind: 'write_file'; path: string; content: string }
  | { kind: 'mkdir'; path: string }
  | { kind: 'delete_path'; path: string }
  | { kind: 'run_command'; command: string }

type NonCommandWorkspaceAction = Exclude<DesktopWorkspaceAction, { kind: 'run_command' }>

type PendingLocalActionState = {
  id: string
  threadId: string
  workspaceName: string
  workspacePath: string
  action: DesktopWorkspaceAction
  source: 'manual' | 'agent'
}

type RunningCommandState = {
  id: string
  threadId: string
  workspaceName: string
  cwd: string
  command: string
  source: 'manual' | 'agent'
}

type ActionLoopResult =
  | { kind: 'action'; action: DesktopWorkspaceAction }
  | { kind: 'answer'; message: Message }

type ActionResultPayload = {
  kind: DesktopWorkspaceAction['kind']
  ok: boolean
  summary: string
}

type ActionCompletion = {
  ok: boolean
  actionResultSummary: string
  summaryContent: string
  summaryMetadata: MessageMetadata
  toolResultSummary?: string
}

interface ChatState {
  threads: Thread[]
  activeThread: Thread | null
  messages: Message[]
  isStreaming: boolean
  isThinking: boolean
  liveBlocks: ContentBlock[]
  error: string | null
  loadThreads: () => Promise<void>
  selectThread: (threadId: string) => Promise<void>
  createThread: () => Promise<string | null>
  deleteThread: (threadId: string) => Promise<void>
  sendMessage: (text: string) => Promise<void>
  approveCommand: (executionId: string) => Promise<void>
  rejectCommand: (executionId: string) => Promise<void>
  killCommand: (executionId: string) => Promise<void>
  clearError: () => void
}

const ChatContext = createContext<ChatState | null>(null)

function isLikelyLocalWorkspaceIntent(text: string): boolean {
  return /\b(file|folder|directory|workspace|create|edit|write|rewrite|read|open|delete|remove|mkdir|terminal|command|run|install|exec|execute|ls|cat|pwd|git|pnpm|npm|node|python|tsc)\b/i.test(text)
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n...[truncated]`
}

function buildAgentActionToolBlock(action: DesktopWorkspaceAction): Extract<ContentBlock, { type: 'tool' }> {
  switch (action.kind) {
    case 'list_files':
      return { type: 'tool', id: crypto.randomUUID(), name: action.kind, label: `Listing ${action.path || '.'}`, icon: 'list', status: 'running' }
    case 'read_file':
      return { type: 'tool', id: crypto.randomUUID(), name: action.kind, label: `Reading ${action.path}`, icon: 'file-text', status: 'running' }
    case 'write_file':
      return { type: 'tool', id: crypto.randomUUID(), name: action.kind, label: `Writing ${action.path}`, icon: 'file-pen', status: 'running' }
    case 'mkdir':
      return { type: 'tool', id: crypto.randomUUID(), name: action.kind, label: `Creating folder ${action.path}`, icon: 'edit', status: 'running' }
    case 'delete_path':
      return { type: 'tool', id: crypto.randomUUID(), name: action.kind, label: `Deleting ${action.path}`, icon: 'zap', status: 'running' }
    case 'run_command':
      return { type: 'tool', id: crypto.randomUUID(), name: action.kind, label: `Preparing ${action.command}`, icon: 'zap', status: 'running' }
  }
}

function buildApprovalBlock(id: string, action: Extract<DesktopWorkspaceAction, { kind: 'run_command' | 'write_file' | 'mkdir' | 'delete_path' }>, workspacePath: string): ApprovalContentBlock {
  switch (action.kind) {
    case 'run_command':
      return {
        type: 'approval',
        id,
        kind: action.kind,
        title: 'Command approval',
        description: 'Run this shell command inside the selected workspace.',
        subject: `$ ${action.command}`,
        footer: workspacePath,
        status: 'pending',
      }
    case 'write_file':
      return {
        type: 'approval',
        id,
        kind: action.kind,
        title: 'File change approval',
        description: 'Write this file inside the selected workspace.',
        subject: action.path,
        footer: workspacePath,
        status: 'pending',
      }
    case 'mkdir':
      return {
        type: 'approval',
        id,
        kind: action.kind,
        title: 'Folder creation approval',
        description: 'Create this folder inside the selected workspace.',
        subject: action.path,
        footer: workspacePath,
        status: 'pending',
      }
    case 'delete_path':
      return {
        type: 'approval',
        id,
        kind: action.kind,
        title: 'Delete approval',
        description: 'Delete this path inside the selected workspace.',
        subject: action.path,
        footer: workspacePath,
        status: 'pending',
      }
  }
}

function summarizeCommandCompletion(input: {
  command: string
  cwd: string
  status: 'done' | 'failed' | 'rejected'
  exitCode?: number | null
  signal?: string | null
  durationMs?: number
  stdout?: string
  stderr?: string
}): ActionCompletion {
  const durationLabel = input.durationMs ? ` in ${Math.max(1, Math.round(input.durationMs / 1000))}s` : ''
  const exitLabel = input.exitCode !== undefined ? `exit code ${input.exitCode ?? 'unknown'}` : 'no exit code'
  const signalLabel = input.signal ? ` (signal ${input.signal})` : ''
  const stdoutTail = truncateText(input.stdout?.trim() || '', 6000)
  const stderrTail = truncateText(input.stderr?.trim() || '', 4000)

  if (input.status === 'rejected') {
    return {
      ok: false,
      actionResultSummary: `User rejected command: ${input.command}`,
      summaryContent: `Rejected command \`${input.command}\`.`,
      summaryMetadata: {
        localCommandSummary: {
          command: input.command,
          cwd: input.cwd,
          status: 'rejected',
        },
      },
      toolResultSummary: 'Rejected',
    }
  }

  const actionResultSummary = [
    `Command: ${input.command}`,
    `Working directory: ${input.cwd}`,
    `Status: ${input.status}`,
    `Exit: ${exitLabel}${signalLabel}`,
    input.durationMs ? `Duration: ${input.durationMs}ms` : '',
    stdoutTail ? `STDOUT:\n${stdoutTail}` : '',
    stderrTail ? `STDERR:\n${stderrTail}` : '',
  ].filter(Boolean).join('\n\n')

  return {
    ok: input.status === 'done',
    actionResultSummary,
    summaryContent: `Executed \`${input.command}\` in \`${input.cwd}\` with ${exitLabel}${signalLabel}${durationLabel}.`,
    summaryMetadata: {
      localCommandSummary: {
        command: input.command,
        cwd: input.cwd,
        status: input.status,
        exitCode: input.exitCode,
        durationMs: input.durationMs,
      },
    },
    toolResultSummary: input.status === 'done' ? `Completed with ${exitLabel}` : `Failed with ${exitLabel}${signalLabel}`,
  }
}

function summarizeWorkspaceAction(action: NonCommandWorkspaceAction, result: { success: boolean; data?: unknown; error?: string }): ActionCompletion {
  const targetPath = action.kind === 'list_files' ? action.path || '.' : action.path

  if (!result.success) {
    const errorMessage = result.error || 'Action failed'
    return {
      ok: false,
      actionResultSummary: `Failed to ${action.kind} ${targetPath}: ${errorMessage}`,
      summaryContent: `Failed to ${action.kind.replace('_', ' ')} \`${targetPath}\`.`,
      summaryMetadata: {
        localFileSummary: {
          kind: action.kind,
          path: targetPath,
          status: 'failed',
        },
      },
      toolResultSummary: errorMessage,
    }
  }

  switch (action.kind) {
    case 'list_files': {
      const payload = (result.data ?? {}) as { items?: Array<{ name: string; type: string }> }
      const items = payload.items ?? []
      const preview = items
        .slice(0, 40)
        .map((item) => `- [${item.type === 'directory' ? 'dir' : item.type}] ${item.name}`)
        .join('\n')
      const truncatedLabel = items.length > 40 ? `\n...and ${items.length - 40} more` : ''
      return {
        ok: true,
        actionResultSummary: `Directory listing for ${targetPath}:\n${preview}${truncatedLabel}`.trim(),
        summaryContent: `Listed files in \`${targetPath}\`.`,
        summaryMetadata: {
          localFileSummary: {
            kind: action.kind,
            path: targetPath,
            status: 'done',
          },
        },
        toolResultSummary: `Found ${items.length} item${items.length === 1 ? '' : 's'}`,
      }
    }
    case 'read_file': {
      const payload = (result.data ?? {}) as { content?: string }
      const content = truncateText(payload.content ?? '', 12000)
      return {
        ok: true,
        actionResultSummary: `File content for ${targetPath}:\n\n${content}`,
        summaryContent: `Read file \`${targetPath}\`.`,
        summaryMetadata: {
          localFileSummary: {
            kind: action.kind,
            path: targetPath,
            status: 'done',
          },
        },
        toolResultSummary: 'Read complete',
      }
    }
    case 'write_file': {
      const payload = (result.data ?? {}) as { bytes?: number }
      return {
        ok: true,
        actionResultSummary: `Wrote ${targetPath}${typeof payload.bytes === 'number' ? ` (${payload.bytes} bytes)` : ''}.`,
        summaryContent: `Wrote file \`${targetPath}\`.`,
        summaryMetadata: {
          localFileSummary: {
            kind: action.kind,
            path: targetPath,
            status: 'done',
          },
        },
        toolResultSummary: 'Write complete',
      }
    }
    case 'mkdir':
      return {
        ok: true,
        actionResultSummary: `Created folder ${targetPath}.`,
        summaryContent: `Created folder \`${targetPath}\`.`,
        summaryMetadata: {
          localFileSummary: {
            kind: action.kind,
            path: targetPath,
            status: 'done',
          },
        },
        toolResultSummary: 'Folder created',
      }
    case 'delete_path':
      return {
        ok: true,
        actionResultSummary: `Deleted ${targetPath}.`,
        summaryContent: `Deleted \`${targetPath}\`.`,
        summaryMetadata: {
          localFileSummary: {
            kind: action.kind,
            path: targetPath,
            status: 'done',
          },
        },
        toolResultSummary: 'Deleted',
      }
  }
}

export function ChatProvider({ children }: { children: ReactNode }): JSX.Element {
  const { token } = useAuth()
  const {
    currentWorkspace,
    bindThreadToCurrentWorkspace,
    unbindThread,
    isThreadInCurrentWorkspace,
  } = useWorkspace()
  const [allThreads, setAllThreads] = useState<Thread[]>([])
  const [activeThread, setActiveThread] = useState<Thread | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [isThinking, setIsThinking] = useState(false)
  const [liveBlocks, setLiveBlocks] = useState<ContentBlock[]>([])
  const [error, setError] = useState<string | null>(null)

  const activeRequestIdRef = useRef<string | null>(null)
  const activeThreadRef = useRef<Thread | null>(null)
  const liveBlocksRef = useRef<ContentBlock[]>([])
  const loadThreadsRef = useRef<(() => Promise<void>) | null>(null)
  const pendingLocalActionRef = useRef<PendingLocalActionState | null>(null)
  const runningCommandRef = useRef<RunningCommandState | null>(null)

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

  const resetLiveState = useCallback(() => {
    setLiveBlocks([])
    liveBlocksRef.current = []
    setIsStreaming(false)
    setIsThinking(false)
    activeRequestIdRef.current = null
    pendingLocalActionRef.current = null
    runningCommandRef.current = null
  }, [])

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
          ? {
            ...block,
            status: completion.ok ? 'done' : 'failed',
            resultSummary: completion.toolResultSummary,
          }
          : block,
      ),
    )

    await persistLocalSummary({
      threadId: input.threadId,
      content: completion.summaryContent,
      metadata: completion.summaryMetadata,
    })

    return completion
  }, [currentWorkspace, persistLocalSummary, replaceLiveBlocks])

  const runAgentLocalActionTurn = useCallback(async (input: {
    threadId: string
    initialMessage?: string
    actionResult?: ActionResultPayload
  }): Promise<void> => {
    if (!token || !currentWorkspace) return
    if (typeof window.desktopAPI.chat.act !== 'function') {
      setError('Workspace tools are not loaded in this desktop session. Restart the Electron app to enable file and terminal actions.')
      resetLiveState()
      return
    }

    setIsThinking(true)

    try {
      const response = await window.desktopAPI.chat.act(token, input.threadId, {
        message: input.initialMessage,
        workspace: {
          name: currentWorkspace.name,
          path: currentWorkspace.path,
        },
        actionResult: input.actionResult,
      })

      if (!response.success || !response.data) {
        throw new Error(response.message || 'Desktop action loop failed')
      }

      const payload = response.data as ActionLoopResult

      if (payload.kind === 'answer') {
        setIsThinking(false)
        await finalizeLocalBlocks({
          threadId: input.threadId,
          appendPersistedMessage: payload.message,
        })
        return
      }

      const { action } = payload
      setIsThinking(false)

      if (action.kind === 'list_files' || action.kind === 'read_file') {
        const toolBlock = buildAgentActionToolBlock(action)
        replaceLiveBlocks((prev) => [...prev, toolBlock])
        const completion = await runWorkspaceAction({
          action,
          toolBlockId: toolBlock.id,
          threadId: input.threadId,
        })
        await runAgentLocalActionTurn({
          threadId: input.threadId,
          actionResult: {
            kind: action.kind,
            ok: completion.ok,
            summary: completion.actionResultSummary,
          },
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
      }

      replaceLiveBlocks((prev) => [
        ...prev,
        buildApprovalBlock(
          actionId,
          action as Extract<DesktopWorkspaceAction, { kind: 'run_command' | 'write_file' | 'mkdir' | 'delete_path' }>,
          currentWorkspace.path,
        ),
      ])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Desktop action loop failed')
      resetLiveState()
    }
  }, [currentWorkspace, finalizeLocalBlocks, replaceLiveBlocks, resetLiveState, runWorkspaceAction, token])

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

    await persistLocalSummary({
      threadId: runningCommand.threadId,
      content: completion.summaryContent,
      metadata: completion.summaryMetadata,
    })

    runningCommandRef.current = null

    if (runningCommand.source === 'agent') {
      await runAgentLocalActionTurn({
        threadId: runningCommand.threadId,
        actionResult: {
          kind: 'run_command',
          ok: completion.ok,
          summary: completion.actionResultSummary,
        },
      })
      return
    }

    await finalizeLocalBlocks({
      threadId: runningCommand.threadId,
    })
  }, [finalizeLocalBlocks, persistLocalSummary, runAgentLocalActionTurn])

  useEffect(() => {
    const unsubscribe = window.desktopAPI.chat.onStreamEvent(({ requestId, event }) => {
      if (activeRequestIdRef.current !== requestId) return

      switch (event.type) {
        case 'thinking_token': {
          const delta = String(event.data ?? '')
          if (!delta) break
          replaceLiveBlocks((prev) => {
            const last = prev[prev.length - 1]
            if (last?.type !== 'thinking') return prev
            return [
              ...prev.slice(0, -1),
              { ...last, text: ((last as Extract<ContentBlock, { type: 'thinking' }>).text || '') + delta },
            ]
          })
          break
        }

        case 'thinking': {
          setIsThinking(true)
          replaceLiveBlocks((prev) => [...prev, { type: 'thinking' }])
          break
        }

        case 'activity': {
          const raw = event.data as { id: string; name: string; label: string; icon: string }
          setIsThinking(false)
          replaceLiveBlocks((prev) => [
            ...prev,
            {
              type: 'tool',
              id: raw.id ?? String(Date.now()),
              name: raw.name ?? '',
              label: raw.label ?? raw.name ?? 'Working...',
              icon: raw.icon ?? 'zap',
              status: 'running',
            },
          ])
          break
        }

        case 'activity_done': {
          const raw = event.data as {
            id: string
            label?: string
            icon?: string
            name?: string
            resultSummary?: string
          }
          setIsThinking(true)
          replaceLiveBlocks((prev) => [
            ...prev.map((block) =>
              block.type === 'tool' && block.id === raw.id
                ? {
                  ...block,
                  name: raw.name ?? block.name,
                  label: raw.label ?? block.label,
                  icon: raw.icon ?? block.icon,
                  status: 'done' as const,
                  resultSummary: raw.resultSummary,
                }
                : block,
            ),
            { type: 'thinking' },
          ])
          break
        }

        case 'text': {
          const chunk = String(event.data ?? '')
          setIsThinking(false)
          replaceLiveBlocks((prev) => {
            const last = prev[prev.length - 1]
            if (last?.type === 'text') {
              return [
                ...prev.slice(0, -1),
                { type: 'text', content: last.content + chunk },
              ]
            }
            return [...prev, { type: 'text', content: chunk }]
          })
          break
        }

        case 'error': {
          setError(String(event.data ?? 'Stream failed. Please try again.'))
          resetLiveState()
          break
        }

        case 'done': {
          const raw = event.data as { message?: Message } | null
          const persistedMessage = raw?.message

          setMessages((prev) => {
            if (persistedMessage) return [...prev, persistedMessage]

            const blocks = liveBlocksRef.current
            const textContent = blocks
              .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
              .map((block) => block.content)
              .join('')

            if (!textContent && blocks.length === 0) return prev

            return [
              ...prev,
              {
                id: `assistant-${Date.now()}`,
                threadId: activeThreadRef.current?.id ?? '',
                role: 'assistant',
                content: textContent,
                createdAt: new Date().toISOString(),
                metadata: blocks.length > 0 ? { contentBlocks: blocks } : undefined,
              },
            ]
          })

          setLiveBlocks([])
          liveBlocksRef.current = []
          setIsStreaming(false)
          setIsThinking(false)
          activeRequestIdRef.current = null
          void loadThreadsRef.current?.()
          break
        }

        default:
          break
      }
    })

    return unsubscribe
  }, [replaceLiveBlocks, resetLiveState])

  useEffect(() => {
    const unsubscribe = window.desktopAPI.terminal.onEvent(({ executionId, event }) => {
      const runningCommand = runningCommandRef.current
      if (!runningCommand || runningCommand.id !== executionId) return

      switch (event.type) {
        case 'stdout': {
          const chunk = String(event.data ?? '')
          replaceLiveBlocks((prev) =>
            prev.map((block) =>
              block.type === 'terminal' && block.id === executionId
                ? { ...block, stdout: appendOutput(block.stdout, chunk) }
                : block,
            ),
          )
          break
        }
        case 'stderr': {
          const chunk = String(event.data ?? '')
          replaceLiveBlocks((prev) =>
            prev.map((block) =>
              block.type === 'terminal' && block.id === executionId
                ? { ...block, stderr: appendOutput(block.stderr, chunk) }
                : block,
            ),
          )
          break
        }
        case 'error': {
          const raw = event.data as { message?: string; durationMs?: number }
          replaceLiveBlocks((prev) =>
            prev.map((block) =>
              block.type === 'terminal' && block.id === executionId
                ? {
                  ...block,
                  status: 'failed',
                  stderr: appendOutput(block.stderr, `${raw.message ?? 'Execution failed'}\n`),
                  durationMs: raw.durationMs,
                }
                : block,
            ),
          )
          void finishCommandExecution({
            executionId,
            status: 'failed',
            durationMs: raw.durationMs,
          })
          break
        }
        case 'exit': {
          const raw = event.data as { exitCode?: number | null; signal?: string | null; durationMs?: number }
          const terminalStatus: 'done' | 'failed' = raw.exitCode === 0 ? 'done' : 'failed'
          replaceLiveBlocks((prev) =>
            prev.map((block) =>
              block.type === 'terminal' && block.id === executionId
                ? {
                  ...block,
                  status: terminalStatus,
                  exitCode: raw.exitCode ?? null,
                  signal: raw.signal ?? null,
                  durationMs: raw.durationMs,
                }
                : block,
            ),
          )
          void finishCommandExecution({
            executionId,
            status: terminalStatus,
            exitCode: raw.exitCode ?? null,
            signal: raw.signal ?? null,
            durationMs: raw.durationMs,
          })
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
    if (!currentWorkspace) {
      setActiveThread(null)
      setMessages([])
      return
    }
    if (activeThreadRef.current && !isThreadInCurrentWorkspace(activeThreadRef.current.id)) {
      setActiveThread(null)
      setMessages([])
    }
  }, [currentWorkspace, isThreadInCurrentWorkspace])

  const threads = currentWorkspace
    ? allThreads.filter((thread) => isThreadInCurrentWorkspace(thread.id))
    : []

  const approveCommand = useCallback(async (executionId: string) => {
    const pendingAction = pendingLocalActionRef.current
    if (!pendingAction || pendingAction.id !== executionId) return

    replaceLiveBlocks((prev) =>
      prev.map((block) =>
        block.type === 'approval' && block.id === executionId
          ? { ...block, status: 'approved' as const }
          : block,
      ),
    )

    pendingLocalActionRef.current = null

    if (pendingAction.action.kind === 'run_command') {
      const command = pendingAction.action.command
      runningCommandRef.current = {
        id: executionId,
        threadId: pendingAction.threadId,
        workspaceName: pendingAction.workspaceName,
        cwd: pendingAction.workspacePath,
        command,
        source: pendingAction.source,
      }

      replaceLiveBlocks((prev) => [
        ...prev,
        {
          type: 'terminal',
          id: executionId,
          command,
          cwd: pendingAction.workspacePath,
          status: 'running',
          stdout: '',
          stderr: '',
        },
      ])

      const result = await window.desktopAPI.terminal.exec(
        executionId,
        command,
        pendingAction.workspacePath,
      )

      if (!result.success) {
        replaceLiveBlocks((prev) =>
          prev.map((block) =>
            block.type === 'terminal' && block.id === executionId
              ? {
                ...block,
                status: 'failed',
                stderr: appendOutput(block.stderr, `${result.error ?? 'Execution failed'}\n`),
              }
              : block,
          ),
        )
        await finishCommandExecution({
          executionId,
          status: 'failed',
        })
      }
      return
    }

    const toolBlock = buildAgentActionToolBlock(pendingAction.action)
    replaceLiveBlocks((prev) => [...prev, toolBlock])

    const completion = await runWorkspaceAction({
      action: pendingAction.action,
      toolBlockId: toolBlock.id,
      threadId: pendingAction.threadId,
    })

    if (pendingAction.source === 'agent') {
      await runAgentLocalActionTurn({
        threadId: pendingAction.threadId,
        actionResult: {
          kind: pendingAction.action.kind,
          ok: completion.ok,
          summary: completion.actionResultSummary,
        },
      })
      return
    }

    await finalizeLocalBlocks({
      threadId: pendingAction.threadId,
    })
  }, [appendOutput, finalizeLocalBlocks, finishCommandExecution, replaceLiveBlocks, runAgentLocalActionTurn, runWorkspaceAction])

  const rejectCommand = useCallback(async (executionId: string) => {
    const pendingAction = pendingLocalActionRef.current
    if (!pendingAction || pendingAction.id !== executionId) return

    replaceLiveBlocks((prev) =>
      prev.map((block) =>
        block.type === 'approval' && block.id === executionId
          ? { ...block, status: 'rejected' as const }
          : block,
      ),
    )

    pendingLocalActionRef.current = null

    if (pendingAction.action.kind === 'run_command') {
      const completion = summarizeCommandCompletion({
        command: pendingAction.action.command,
        cwd: pendingAction.workspacePath,
        status: 'rejected',
      })

      if (pendingAction.source === 'agent') {
        await persistLocalSummary({
          threadId: pendingAction.threadId,
          content: completion.summaryContent,
          metadata: completion.summaryMetadata,
        })
        await runAgentLocalActionTurn({
          threadId: pendingAction.threadId,
          actionResult: {
            kind: 'run_command',
            ok: false,
            summary: completion.actionResultSummary,
          },
        })
        return
      }

      await finalizeLocalBlocks({
        threadId: pendingAction.threadId,
        summaryContent: completion.summaryContent,
        summaryMetadata: completion.summaryMetadata,
      })
      return
    }

    const fileAction = pendingAction.action as Extract<DesktopWorkspaceAction, { kind: 'write_file' | 'mkdir' | 'delete_path' }>
    const summaryContent = `Rejected ${fileAction.kind.replace('_', ' ')} for \`${fileAction.path}\`.`
    const summaryMetadata: MessageMetadata = {
      localFileSummary: {
        kind: fileAction.kind,
        path: fileAction.path,
        status: 'rejected',
      },
    }

    if (pendingAction.source === 'agent') {
      await persistLocalSummary({
        threadId: pendingAction.threadId,
        content: summaryContent,
        metadata: summaryMetadata,
      })
      await runAgentLocalActionTurn({
        threadId: pendingAction.threadId,
        actionResult: {
          kind: fileAction.kind,
          ok: false,
          summary: `User rejected ${fileAction.kind} for ${fileAction.path}`,
        },
      })
      return
    }

    await finalizeLocalBlocks({
      threadId: pendingAction.threadId,
      summaryContent,
      summaryMetadata,
    })
  }, [finalizeLocalBlocks, persistLocalSummary, replaceLiveBlocks, runAgentLocalActionTurn])

  const killCommand = useCallback(async (executionId: string) => {
    const runningCommand = runningCommandRef.current
    if (!runningCommand || runningCommand.id !== executionId) return

    const result = await window.desktopAPI.terminal.kill(executionId)
    if (!result.success) {
      setError(result.error ?? 'Failed to stop command')
    }
  }, [])

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
    try {
      const res = await window.desktopAPI.threads.get(token, threadId)
      if (res.success && res.data) {
        const data = res.data as { thread: Thread; messages: Message[] }
        setActiveThread(data.thread)
        setMessages(data.messages)
        setError(null)
      }
    } catch {
      setError('Failed to load thread')
    }
  }, [token, currentWorkspace, isThreadInCurrentWorkspace])

  const createThread = useCallback(async (): Promise<string | null> => {
    if (!token || !currentWorkspace) return null
    try {
      const res = await window.desktopAPI.threads.create(token)
      if (res.success && res.data) {
        const newThread = res.data as Thread
        bindThreadToCurrentWorkspace(newThread.id)
        setAllThreads((prev) => [newThread, ...prev])
        setActiveThread(newThread)
        setMessages([])
        return newThread.id
      }
      return null
    } catch {
      setError('Failed to create thread')
      return null
    }
  }, [token, currentWorkspace, bindThreadToCurrentWorkspace])

  const sendMessage = useCallback(async (text: string) => {
    if (!token || !currentWorkspace || !activeThread || isStreaming) return

    const trimmedText = text.trim()
    if (!trimmedText) return

    const userMsg: Message = {
      id: `temp-${Date.now()}`,
      threadId: activeThread.id,
      role: 'user',
      content: trimmedText,
      createdAt: new Date().toISOString(),
    }
    setMessages((prev) => [...prev, userMsg])
    setIsStreaming(true)
    setIsThinking(false)
    setLiveBlocks([])
    liveBlocksRef.current = []
    setError(null)

    const runMatch = trimmedText.match(/^\/run\s+([\s\S]+)$/i)
    if (runMatch) {
      const command = runMatch[1].trim()
      try {
        await window.desktopAPI.threads.addMessage(token, activeThread.id, {
          role: 'user',
          content: trimmedText,
        })
      } catch {
        setError('Failed to save the command request.')
      }

      const executionId = crypto.randomUUID()
      pendingLocalActionRef.current = {
        id: executionId,
        threadId: activeThread.id,
        workspaceName: currentWorkspace.name,
        workspacePath: currentWorkspace.path,
        action: { kind: 'run_command', command },
        source: 'manual',
      }

      const approvalBlock = buildApprovalBlock(
        executionId,
        { kind: 'run_command', command },
        currentWorkspace.path,
      )
      setLiveBlocks([approvalBlock])
      liveBlocksRef.current = [approvalBlock]
      return
    }

    if (isLikelyLocalWorkspaceIntent(trimmedText)) {
      await runAgentLocalActionTurn({
        threadId: activeThread.id,
        initialMessage: trimmedText,
      })
      return
    }

    try {
      const requestId = crypto.randomUUID()
      activeRequestIdRef.current = requestId
      const sendRes = await window.desktopAPI.chat.startStream(token, activeThread.id, trimmedText, requestId)
      if (!sendRes.success) {
        setError('Failed to send message')
        setIsStreaming(false)
        setIsThinking(false)
        activeRequestIdRef.current = null
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setError('Stream failed. Please try again.')
      setIsStreaming(false)
      setIsThinking(false)
      activeRequestIdRef.current = null
    }
  }, [token, currentWorkspace, activeThread, isStreaming, runAgentLocalActionTurn])

  const clearError = useCallback(() => setError(null), [])

  const deleteThread = useCallback(async (threadId: string) => {
    if (!token) return
    try {
      const result = await window.desktopAPI.threads.delete(token, threadId)
      if (!result?.success) {
        console.error('delete thread failed:', result)
        setError('Failed to delete thread')
        return
      }
      unbindThread(threadId)
      setAllThreads((prev) => prev.filter((thread) => thread.id !== threadId))
      if (activeThreadRef.current?.id === threadId) {
        setActiveThread(null)
        setMessages([])
      }
    } catch (err) {
      console.error('delete thread IPC error:', err)
      setError('Failed to delete thread — please restart the app and try again')
    }
  }, [token, unbindThread])

  return (
    <ChatContext.Provider
      value={{
        threads,
        activeThread,
        messages,
        isStreaming,
        isThinking,
        liveBlocks,
        error,
        loadThreads,
        selectThread,
        createThread,
        deleteThread,
        sendMessage,
        approveCommand,
        rejectCommand,
        killCommand,
        clearError,
      }}
    >
      {children}
    </ChatContext.Provider>
  )
}

export function useChat(): ChatState {
  const ctx = useContext(ChatContext)
  if (!ctx) throw new Error('useChat must be used within ChatProvider')
  return ctx
}
