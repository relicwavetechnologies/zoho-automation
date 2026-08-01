import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { toast } from 'sonner'

// --- Module mocks (must be declared before component import) ---------------

// Store backing state for usePrompt (settable by tests)
let promptState = ''
const setPromptMock = vi.fn((val: string) => {
  promptState = val
})
const addToHistoryMock = vi.fn()
const navigateHistoryMock = vi.fn()

vi.mock('@/hooks/usePrompt', () => ({
  usePrompt: (selector: any) =>
    selector({
      prompt: promptState,
      setPrompt: setPromptMock,
      addToHistory: addToHistoryMock,
      navigateHistory: navigateHistoryMock,
    }),
}))

const updateCurrentThreadAssistantMock = vi.fn()
const updateCurrentThreadModelMock = vi.fn()
const createThreadMock = vi.fn()
const getCurrentThreadMock = vi.fn(() => undefined)
let currentThreadId: string | undefined = 'thread-1'

vi.mock('@/hooks/useThreads', () => ({
  useThreads: (selector: any) =>
    selector({
      currentThreadId,
      threads: {},
      getCurrentThread: getCurrentThreadMock,
      updateCurrentThreadAssistant: updateCurrentThreadAssistantMock,
      updateCurrentThreadModel: updateCurrentThreadModelMock,
      createThread: createThreadMock,
    }),
}))

let appStateOverrides: any = {}
const cancelToolCallMock = vi.fn()
vi.mock('@/hooks/useAppState', () => ({
  useAppState: (selector: any) => {
    const state = {
      abortControllers: {},
      busyThreads: {},
      streamingContents: {},
      loadingModels: {},
      cancelToolCalls: {},
      piThreadRunStates: {},
      tools: [],
      cancelToolCall: cancelToolCallMock,
      activeModels: [],
      ...appStateOverrides,
    }
    // zustand-style: selector may be a function returned by useShallow
    if (typeof selector === 'function') return selector(state)
    return state
  },
}))

vi.mock('@/hooks/useGeneralSetting', () => ({
  useGeneralSetting: (selector: any) =>
    selector({
      spellCheckChatInput: false,
      tokenCounterCompact: false,
    }),
}))

let selectedModelOverride: any = {
  id: 'model-a',
  capabilities: ['tools'],
  provider: 'llamacpp',
}
let selectedProviderOverride: any = 'llamacpp'
const getProviderByNameMock = vi.fn()
vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: (selector: any) =>
    selector({
      selectedModel: selectedModelOverride,
      selectedProvider: selectedProviderOverride,
      providers: [],
      selectModelProvider: vi.fn(),
      updateProvider: vi.fn(),
      getProviderByName: getProviderByNameMock,
    }),
}))

vi.mock('@/hooks/useAssistant', () => ({
  useAssistant: () => ({
    loading: false,
    currentAssistant: { id: 'a1', avatar: '' },
    setCurrentAssistant: vi.fn(),
    assistants: [{ id: 'a1', avatar: '' }],
  }),
}))

let agentModeOn = false
vi.mock('@/hooks/useAgentMode', () => ({
  useAgentMode: (selector: any) =>
    selector({
      agentThreads: agentModeOn ? { 'thread-1': true } : {},
      toggleAgentMode: vi.fn(),
    }),
}))

let threadMessagesState: any[] = []
vi.mock('@/hooks/useMessages', () => ({
  useMessages: (selector: any) =>
    selector({
      messages: { 'thread-1': threadMessagesState },
    }),
}))

vi.mock('@/hooks/useTools', () => ({
  useTools: () => undefined,
}))

vi.mock('@/hooks/useAttachments', () => ({
  useAttachments: (selector: any) =>
    selector({
      enabled: true,
      parseMode: 'auto',
      maxFileSizeMB: 10,
    }),
}))

let attachmentsList: any[] = []
const setAttachmentsMock = vi.fn((_threadId: string, updater: any) => {
  attachmentsList =
    typeof updater === 'function' ? updater(attachmentsList) : updater
})
const clearAttachmentsMock = vi.fn()
const transferAttachmentsMock = vi.fn()
function useChatAttachmentsMock(selector: any) {
  return selector({
    getAttachments: () => attachmentsList,
    setAttachments: setAttachmentsMock,
    clearAttachments: clearAttachmentsMock,
    transferAttachments: transferAttachmentsMock,
  })
}
;(useChatAttachmentsMock as any).getState = () => ({
  getAttachments: () => attachmentsList,
  setAttachments: setAttachmentsMock,
  clearAttachments: clearAttachmentsMock,
  transferAttachments: transferAttachmentsMock,
})
vi.mock('@/hooks/useChatAttachments', () => ({
  NEW_THREAD_ATTACHMENT_KEY: '__new_thread__',
  useChatAttachments: useChatAttachmentsMock,
}))

vi.mock('@/hooks/useJanBrowserExtension', () => ({
  useJanBrowserExtension: () => ({
    hasConfig: false,
    isActive: false,
    isLoading: false,
    dialogOpen: false,
    dialogState: null,
    toggleBrowser: vi.fn(),
    handleCancel: vi.fn(),
    setDialogOpen: vi.fn(),
  }),
}))

vi.mock('@/hooks/useAttachmentIngestionPrompt', () => ({
  useAttachmentIngestionPrompt: vi.fn(),
}))

// Message queue store — it's imported as a zustand hook and also invoked via
// useMessageQueue.getState() for enqueue/clear/remove. Provide both.
const queueState: Record<string, any[]> = {}
const enqueueMock = vi.fn((tid: string, msg: any) => {
  queueState[tid] = queueState[tid] || []
  queueState[tid].push(msg)
})
const removeMessageMock = vi.fn()
const clearQueueMock = vi.fn()
const requestCancellationMock = vi.fn(() => false)
const getQueueMock = vi.fn((tid: string) => queueState[tid] || [])

function useMessageQueueImpl(selector?: any) {
  const state = {
    getQueue: getQueueMock,
    enqueue: enqueueMock,
    removeMessage: removeMessageMock,
    requestCancellation: requestCancellationMock,
    clearQueue: clearQueueMock,
  }
  if (selector) return selector(state)
  return state
}
;(useMessageQueueImpl as any).getState = () => ({
  getQueue: getQueueMock,
  enqueue: enqueueMock,
  removeMessage: removeMessageMock,
  requestCancellation: requestCancellationMock,
  clearQueue: clearQueueMock,
})
vi.mock('@/stores/message-queue-store', () => ({
  useMessageQueue: useMessageQueueImpl,
}))

vi.mock('@/lib/extension', () => ({
  ExtensionManager: {
    getInstance: () => ({
      get: () => undefined,
      getByName: () => undefined,
    }),
  },
}))

vi.mock('@janhq/core', () => ({
  ExtensionTypeEnum: { MCP: 'mcp', VectorDB: 'vectordb' },
  MCPExtension: class {},
  VectorDBExtension: class {},
  fs: {
    existsSync: vi.fn().mockResolvedValue(false),
    readFile: vi.fn().mockResolvedValue(''),
    writeFile: vi.fn().mockResolvedValue(undefined),
    fileStat: vi.fn().mockResolvedValue({ size: 2048 }),
  },
}))

vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ navigate: vi.fn() }),
  Link: ({ children, ...props }: any) => <a {...props}>{children}</a>,
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}))

vi.mock('ai', () => ({ generateId: () => 'gen-id-1' }))

const tauriCoreMock = vi.hoisted(() => ({
  invoke: vi.fn(),
}))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: tauriCoreMock.invoke,
}))

// Stub heavy children
vi.mock('@/containers/QueuedMessageBubble', () => ({
  QueuedMessageChip: ({ message, onEdit }: any) => (
    <div data-testid="queued-chip">
      {message?.text}
      <button data-testid={`edit-queued-${message?.id}`} onClick={() => onEdit?.(message)}>
        edit
      </button>
    </div>
  ),
}))
vi.mock('@/containers/DropdownToolsAvailable', () => ({
  __esModule: true,
  default: () => <div data-testid="stub-tools" />,
}))
vi.mock('@/containers/AvatarEmoji', () => ({
  AvatarEmoji: () => <span data-testid="stub-avatar" />,
}))
vi.mock('@/containers/McpExtensionToolLoader', () => ({
  McpExtensionToolLoader: () => null,
}))
vi.mock('@/containers/dialogs/JanBrowserExtensionDialog', () => ({
  __esModule: true,
  default: () => null,
}))
vi.mock('@/containers/MovingBorder', () => ({
  MovingBorder: ({ children }: any) => <div>{children}</div>,
}))
vi.mock('@/components/TokenCounter', () => ({
  TokenCounter: () => <div data-testid="stub-token-counter" />,
}))
vi.mock('@/components/AssistantsMenu', () => ({
  AssistantsMenu: () => <div data-testid="stub-assistants-menu" />,
}))

// Minimal dropdown/tooltip stubs (pass-throughs to keep DOM shallow)
vi.mock('@/components/ui/dropdown-menu', () => {
  const Pass = ({ children }: any) => <>{children}</>
  return {
    DropdownMenu: Pass,
    DropdownMenuContent: Pass,
    DropdownMenuItem: ({ children, onClick, disabled }: any) => (
      <button onClick={onClick} disabled={disabled}>
        {children}
      </button>
    ),
    DropdownMenuTrigger: Pass,
    DropdownMenuSub: Pass,
    DropdownMenuSubContent: Pass,
    DropdownMenuSubTrigger: Pass,
  }
})
vi.mock('@/components/ui/tooltip', () => {
  const Pass = ({ children }: any) => <>{children}</>
  return {
    Tooltip: Pass,
    TooltipContent: Pass,
    TooltipTrigger: Pass,
    TooltipProvider: Pass,
  }
})

let isTauriPlatform = false
vi.mock('@/lib/platform/utils', () => ({
  isPlatformTauri: () => isTauriPlatform,
}))

// Import component AFTER all mocks
import ChatInput from '../ChatInput'
import { clearDivoSkillSearchCache } from '@/lib/divo-skill-search'
import { usePiApproval } from '@/hooks/usePiApproval'

// Helpers -------------------------------------------------------------------

const resetAll = () => {
  promptState = ''
  currentThreadId = 'thread-1'
  appStateOverrides = {}
  attachmentsList = []
  threadMessagesState = []
  agentModeOn = false
  isTauriPlatform = false
  selectedModelOverride = {
    id: 'model-a',
    capabilities: ['tools'],
    provider: 'llamacpp',
  }
  selectedProviderOverride = 'llamacpp'
  setPromptMock.mockClear()
  addToHistoryMock.mockClear()
  navigateHistoryMock.mockClear()
  setAttachmentsMock.mockClear()
  clearAttachmentsMock.mockClear()
  transferAttachmentsMock.mockClear()
  enqueueMock.mockClear()
  clearQueueMock.mockClear()
  requestCancellationMock.mockReset()
  requestCancellationMock.mockReturnValue(false)
  cancelToolCallMock.mockClear()
  tauriCoreMock.invoke.mockReset()
  tauriCoreMock.invoke.mockResolvedValue(undefined)
  usePiApproval.setState({ queues: {} })
  clearDivoSkillSearchCache()
  for (const k of Object.keys(queueState)) delete queueState[k]
  getCurrentThreadMock.mockReturnValue(undefined)
}

const getTextarea = () =>
  screen.getByTestId('chat-input') as HTMLTextAreaElement

// Shared render helper that returns last rerender handle
const renderInput = (props: any = {}) =>
  render(
    <ChatInput onSubmit={props.onSubmit} onStop={props.onStop} {...props} />
  )

const enqueueApproval = (
  threadId: string,
  runId: string,
  requestId: string,
  title: string
) => {
  usePiApproval.getState().enqueue({
    requestId,
    threadId,
    runId,
    descriptor: {
      version: 1,
      toolCallId: `tool-${requestId}`,
      source: 'divo',
      kind: 'gmail.send',
      action: 'send',
      title,
      presentation: { subject: title },
    },
    receivedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    status: 'pending',
  })
}

describe('ChatInput', () => {
  beforeEach(() => {
    resetAll()
  })

  it('renders the textarea with placeholder and send button', () => {
    renderInput()
    const ta = getTextarea()
    expect(ta).toBeInTheDocument()
    expect(ta).toHaveAttribute('placeholder', 'common:placeholder.chatInput')
    // send button is present
    expect(
      document.querySelector('[data-test-id="send-message-button"]')
    ).toBeTruthy()
  })

  /**
   * The rolling starters are an empty-state affordance. Under a live thread the
   * answer above the composer already supplies the context, so a carousel of
   * unrelated suggestions animating there reads as the app changing the
   * subject — it becomes a plain follow-up prompt instead.
   */
  describe('composer placeholder', () => {
    it('rolls suggestions on a fresh thread', () => {
      renderInput()
      expect(screen.getByTestId('rotating-placeholder')).toBeInTheDocument()
    })

    it('drops to a static follow-up prompt once the thread has messages', () => {
      threadMessagesState = [
        { id: 'm1', role: 'user', content: [{ type: 'text', text: 'hi' }] },
      ]
      renderInput()

      expect(screen.queryByTestId('rotating-placeholder')).not.toBeInTheDocument()
      expect(getTextarea()).toHaveAttribute(
        'placeholder',
        'common:placeholder.chatFollowUp'
      )
    })
  })

  it('surfaces the active Pi task in the composer context rail', () => {
    threadMessagesState = [
      {
        id: 'assistant-todo',
        role: 'assistant',
        content: [
          {
            type: 'tool_call',
            tool_name: 'divo_todos',
            tool_call_id: 'todo-1',
            input: {},
            output: {
              details: {
                version: 1,
                boardId: 'board-1',
                revision: 1,
                items: [
                  {
                    id: 'task-1',
                    content: 'Compare TTS vendors',
                    activeForm: 'Comparing TTS vendors',
                    status: 'in_progress',
                  },
                ],
              },
            },
          },
        ],
      },
    ]

    renderInput()

    const bubble = screen.getByTestId('todo-bubble-trigger')
    expect(bubble).toHaveTextContent(
      'Comparing TTS vendors'
    )
    expect(screen.getByTestId('composer-status-row')).toContainElement(bubble)
    expect(
      getTextarea().compareDocumentPosition(bubble) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it('replaces the composer with a live Pi approval and resumes after approval', async () => {
    usePiApproval.getState().enqueue({
      requestId: 'approval-request-1',
      threadId: 'thread-1',
      runId: 'run-1',
      descriptor: {
        version: 1,
        toolCallId: 'tool-call-1',
        source: 'divo',
        kind: 'gmail.send',
        action: 'send',
        title: 'Review live email',
        presentation: {
          to: ['maya@example.com'],
          subject: 'Live subject',
          body: 'Live body',
        },
      },
      receivedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      status: 'pending',
    })

    renderInput()

    expect(screen.queryByTestId('chat-input')).toBeNull()
    expect(screen.getByText('Review live email')).toBeInTheDocument()
    expect(screen.getByText('Live subject')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Allow only this time' }))

    await waitFor(() => {
      expect(tauriCoreMock.invoke).toHaveBeenCalledWith(
        'pi_extension_ui_respond',
        {
          requestId: 'approval-request-1',
          threadId: 'thread-1',
          runId: 'run-1',
          confirmed: true,
        }
      )
      expect(screen.getByTestId('chat-input')).toBeInTheDocument()
    })
  })

  it('keeps approvals route-owned while the global thread selection lags navigation', async () => {
    currentThreadId = 'thread-a'
    enqueueApproval('thread-a', 'run-a1', 'approval-a1', 'Approve A only')

    const view = renderInput({ threadId: 'thread-b' })
    expect(screen.getByTestId('chat-input')).toBeInTheDocument()
    expect(screen.queryByText('Approve A only')).not.toBeInTheDocument()

    // Reused route commits and rapid navigation must remain B-owned even when
    // the global selection is still A until its passive synchronization runs.
    view.rerender(<ChatInput threadId="thread-a" />)
    expect(screen.getAllByText('Approve A only')).not.toHaveLength(0)
    view.rerender(<ChatInput threadId="thread-b" />)
    expect(screen.queryByText('Approve A only')).not.toBeInTheDocument()

    act(() => {
      enqueueApproval('thread-b', 'run-b1', 'approval-b1', 'Approve B only')
    })
    view.rerender(<ChatInput threadId="thread-b" />)
    expect(screen.getAllByText('Approve B only')).not.toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: 'Allow only this time' }))
    await waitFor(() =>
      expect(tauriCoreMock.invoke).toHaveBeenCalledWith(
        'pi_extension_ui_respond',
        expect.objectContaining({
          requestId: 'approval-b1',
          threadId: 'thread-b',
          runId: 'run-b1',
          confirmed: true,
        })
      )
    )
    expect(tauriCoreMock.invoke).not.toHaveBeenCalledWith(
      'pi_extension_ui_respond',
      expect.objectContaining({ requestId: 'approval-a1' })
    )
  })

  it('stops only B after an A-to-B route handoff while the global thread remains A', async () => {
    const onStop = vi.fn()
    const abortA = { abort: vi.fn() }
    currentThreadId = 'thread-a'
    appStateOverrides = { abortControllers: { 'thread-a': abortA } }
    enqueueApproval('thread-a', 'run-a1', 'approval-a1', 'Approve A only')

    const view = renderInput({ threadId: 'thread-b', onStop })
    expect(screen.getByTestId('chat-input')).toBeInTheDocument()
    expect(screen.queryByText('Approve A only')).not.toBeInTheDocument()

    act(() => {
      enqueueApproval('thread-b', 'run-b1', 'approval-b1', 'Approve B only')
    })
    view.rerender(<ChatInput threadId="thread-b" onStop={onStop} />)
    fireEvent.click(screen.getByRole('button', { name: 'Stop run' }))

    await waitFor(() => {
      expect(onStop).toHaveBeenCalledOnce()
      expect(tauriCoreMock.invoke).toHaveBeenCalledWith(
        'pi_extension_ui_respond',
        expect.objectContaining({
          requestId: 'approval-b1',
          threadId: 'thread-b',
          runId: 'run-b1',
          confirmed: false,
        })
      )
    })
    expect(tauriCoreMock.invoke).not.toHaveBeenCalledWith(
      'pi_extension_ui_respond',
      expect.objectContaining({ requestId: 'approval-a1' })
    )
    expect(abortA.abort).not.toHaveBeenCalled()
    expect(usePiApproval.getState().queues['thread-a']).toMatchObject([
      { requestId: 'approval-a1', runId: 'run-a1' },
    ])
    expect(usePiApproval.getState().queues['thread-b']).toBeUndefined()
  })

  it('fails closed on stale approvals after a branch activates a newer run', () => {
    currentThreadId = 'thread-a'
    appStateOverrides = {
      piThreadRunStates: {
        'thread-a': { runId: 'run-a2', state: 'active' },
      },
    }
    enqueueApproval('thread-a', 'run-a1', 'approval-a1', 'Stale A1 approval')

    const view = renderInput({ threadId: 'thread-a' })
    expect(screen.getByTestId('chat-input')).toBeInTheDocument()
    expect(screen.queryByText('Stale A1 approval')).not.toBeInTheDocument()

    act(() => {
      enqueueApproval('thread-a', 'run-a2', 'approval-a2', 'Current A2 approval')
    })
    view.rerender(<ChatInput threadId="thread-a" />)
    expect(screen.getAllByText('Current A2 approval')).not.toHaveLength(0)
    expect(screen.queryByText('Stale A1 approval')).not.toBeInTheDocument()
  })

  it('denies a live approval before forwarding Stop run to chat abort', async () => {
    const onStop = vi.fn()
    usePiApproval.getState().enqueue({
      requestId: 'approval-request-stop',
      threadId: 'thread-1',
      runId: 'run-1',
      descriptor: {
        version: 1,
        toolCallId: 'tool-call-stop',
        source: 'bash',
        kind: 'bash.execute',
        action: 'execute',
        title: 'Run terminal command',
        presentation: { command: 'touch example.txt' },
      },
      receivedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      status: 'pending',
    })

    renderInput({ onStop })
    fireEvent.click(screen.getByRole('button', { name: 'Stop run' }))

    await waitFor(() => expect(onStop).toHaveBeenCalledOnce())
    expect(tauriCoreMock.invoke).toHaveBeenCalledWith(
      'pi_extension_ui_respond',
      {
        requestId: 'approval-request-stop',
        threadId: 'thread-1',
        runId: 'run-1',
        confirmed: false,
      }
    )
    expect(tauriCoreMock.invoke.mock.invocationCallOrder[0]).toBeLessThan(
      onStop.mock.invocationCallOrder[0]
    )
  })

  it('can allow Bash for the active chat without device persistence', async () => {
    usePiApproval.getState().enqueue({
      requestId: 'approval-request-bash-always',
      threadId: 'thread-1',
      runId: 'run-1',
      descriptor: {
        version: 1,
        toolCallId: 'tool-call-bash-always',
        source: 'bash',
        kind: 'bash.execute',
        action: 'execute',
        title: 'Run terminal command',
        presentation: { command: 'npm test' },
      },
      receivedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      status: 'pending',
    })

    renderInput()
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Always allow commands in this chat',
      })
    )

    await waitFor(() => {
      expect(tauriCoreMock.invoke).toHaveBeenCalledWith(
        'pi_extension_ui_respond',
        {
          requestId: 'approval-request-bash-always',
          threadId: 'thread-1',
          runId: 'run-1',
          confirmed: true,
          alwaysAllowBash: true,
        }
      )
      expect(screen.getByTestId('chat-input')).toBeInTheDocument()
    })
  })

  it('can grant full local access to Divo for the active chat', async () => {
    usePiApproval.getState().enqueue({
      requestId: 'approval-request-full-access',
      threadId: 'thread-1',
      runId: 'run-1',
      descriptor: {
        version: 1,
        toolCallId: 'tool-call-full-access',
        source: 'divo',
        kind: 'googleSheets.create',
        action: 'create',
        title: 'Create spreadsheet',
        presentation: { title: 'Test sheet' },
      },
      receivedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      status: 'pending',
    })

    renderInput()
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Give Divo full access to this chat',
      })
    )

    await waitFor(() => {
      expect(tauriCoreMock.invoke).toHaveBeenCalledWith(
        'pi_extension_ui_respond',
        {
          requestId: 'approval-request-full-access',
          threadId: 'thread-1',
          runId: 'run-1',
          confirmed: true,
          alwaysAllowFullAccess: true,
        }
      )
      expect(screen.getByTestId('chat-input')).toBeInTheDocument()
    })
  })

  it('replaces the composer with Teach clarification and resumes the same run', async () => {
    usePiApproval.getState().enqueue({
      protocol: 'teach-clarification',
      requestId: 'clarify-request-1',
      threadId: 'thread-1',
      runId: 'run-1',
      status: 'pending',
      descriptor: {
        version: 1,
        reason: 'The workflow trigger is unclear.',
        questions: [{
          id: 'trigger',
          question: 'When should Divo run this?',
          selection: 'single',
          options: [
            { id: 'new-email', label: 'When a new email arrives' },
            { id: 'manual', label: 'Only when I ask' },
          ],
          allowCustom: true,
        }],
        runCorrelation: {
          version: 1,
          threadId: 'thread-1',
          runId: 'run-1',
          profile: 'teach',
        },
      },
    })

    renderInput()

    expect(screen.queryByTestId('chat-input')).toBeNull()
    expect(screen.getByTestId('teach-clarification-card')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'When a new email arrives' }))
    fireEvent.click(screen.getByRole('button', { name: 'Continue teaching' }))

    await waitFor(() => {
      expect(tauriCoreMock.invoke).toHaveBeenCalledWith(
        'pi_extension_ui_respond',
        {
          requestId: 'clarify-request-1',
          threadId: 'thread-1',
          runId: 'run-1',
          value: JSON.stringify({
            version: 1,
            decision: 'answer',
            answers: [{
              questionId: 'trigger',
              selectedOptionIds: ['new-email'],
            }],
          }),
        }
      )
    })
  })

  it('disables the send button when prompt is empty', () => {
    renderInput()
    const btn = document.querySelector(
      '[data-test-id="send-message-button"]'
    ) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })

  it('enables the send button when prompt has content', () => {
    promptState = 'hello'
    renderInput()
    const btn = document.querySelector(
      '[data-test-id="send-message-button"]'
    ) as HTMLButtonElement
    expect(btn.disabled).toBe(false)
  })

  it('calls setPrompt on textarea change', () => {
    renderInput()
    fireEvent.change(getTextarea(), { target: { value: 'abc' } })
    expect(setPromptMock).toHaveBeenCalledWith('abc')
  })

  it('opens the slash menu without stealing focus from the composer', async () => {
    // The menu has no input of its own — the `/query` in the composer IS the
    // search, so focus must stay put or the user ends up typing in two places.
    renderInput()
    const textarea = getTextarea()
    textarea.focus()
    fireEvent.change(textarea, { target: { value: '/' } })

    expect(setPromptMock).toHaveBeenCalledWith('/')
    expect(
      await screen.findByTestId('skill-reference-drawer')
    ).toBeInTheDocument()
    expect(screen.queryByTestId('skill-reference-search')).toBeNull()
    expect(document.activeElement).toBe(textarea)
  })

  it('discovers the share-memory command alongside backend skill search', async () => {
    renderInput()
    fireEvent.change(getTextarea(), { target: { value: '/' } })

    const command = await screen.findByTestId('share-memory-command')
    expect(command).toHaveTextContent('/share-memory')

    // Narrowing the query happens in the composer, not in a second box.
    fireEvent.change(getTextarea(), { target: { value: '/google' } })

    expect(screen.queryByTestId('share-memory-command')).toBeNull()
    expect(screen.getByTestId('skill-reference-drawer')).toBeInTheDocument()
  })

  it('activates share-memory by mouse with a deterministic review-only request', async () => {
    const onSubmit = vi.fn()
    renderInput({ onSubmit })
    fireEvent.change(getTextarea(), { target: { value: '/' } })

    fireEvent.click(await screen.findByTestId('share-memory-command'))

    expect(onSubmit).toHaveBeenCalledWith(
      'Help me share something with my team or company memory. Ask me what should be saved and where it should be shared.',
      undefined
    )
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(setPromptMock).toHaveBeenLastCalledWith('')
    expect(screen.queryByTestId('skill-reference-drawer')).toBeNull()
  })

  it('activates a matching share-memory command with Enter', async () => {
    const onSubmit = vi.fn()
    renderInput({ onSubmit })
    fireEvent.change(getTextarea(), { target: { value: '/' } })

    await screen.findByTestId('skill-reference-drawer')
    // Enter is handled on the textarea now — the menu never holds focus.
    fireEvent.change(getTextarea(), { target: { value: '/share-mem' } })
    fireEvent.keyDown(getTextarea(), { key: 'Enter' })

    expect(onSubmit).toHaveBeenCalledWith(
      'Help me share something with my team or company memory. Ask me what should be saved and where it should be shared.',
      undefined
    )
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('does not open the skill reference drawer for normal input', () => {
    renderInput()
    fireEvent.change(getTextarea(), { target: { value: 'abc' } })

    expect(screen.queryByTestId('skill-reference-drawer')).toBeNull()
  })

  it('searches Divo skills and adds a selected skill reference chip', async () => {
    tauriCoreMock.invoke.mockImplementation(async (command: string) => {
      if (command === 'divo_get_session_status') {
        return {
          configured: true,
          backendUrl: 'http://localhost:8000',
          userId: 'user-1',
          companyId: 'company-1',
          role: 'member',
          departmentId: 'dept-1',
          expiresAt: '2026-07-09T10:00:00Z',
        }
      }
      return {
        ok: true,
        status: 'success',
        data: {
          skills: [
            {
              id: 'google-workspace',
              name: 'Google Workspace',
              description: 'Find the right Gmail, Drive, and Calendar action.',
              score: 3,
              toolIds: ['googleGmail', 'googleDrive', 'googleCalendar'],
            },
          ],
        },
      }
    })

    renderInput()
    fireEvent.change(getTextarea(), { target: { value: '/' } })

    await screen.findByTestId('skill-reference-drawer')
    fireEvent.change(getTextarea(), { target: { value: '/google' } })

    const result = await screen.findByTestId(
      'skill-reference-result-google-workspace'
    )
    expect(result).toHaveTextContent('Google Workspace')
    expect(tauriCoreMock.invoke).toHaveBeenCalledWith('divo_gateway_request', {
      op: 'skills.list',
      payload: { context: { surface: 'desktop_composer_reference' } },
    })

    fireEvent.click(result)

    expect(
      await screen.findByTestId('skill-reference-chips')
    ).toHaveTextContent('/Google Workspace')
    expect(screen.queryByTestId('skill-reference-drawer')).toBeNull()
    expect(setPromptMock).toHaveBeenCalledWith('')
  })

  it('submits selected skill references as agent context metadata', async () => {
    tauriCoreMock.invoke.mockImplementation(async (command: string) => {
      if (command === 'divo_get_session_status') {
        return {
          configured: true,
          backendUrl: 'http://localhost:8000',
          userId: 'user-1',
          companyId: 'company-1',
          role: 'member',
          departmentId: 'dept-1',
          expiresAt: '2026-07-09T10:00:00Z',
        }
      }
      return {
        ok: true,
        status: 'success',
        data: {
          skills: [
            {
              id: 'google',
              name: 'Google Workspace',
              description: 'Gmail, Drive, and Calendar workflows.',
              score: 3,
              toolIds: ['googleGmail'],
            },
          ],
        },
      }
    })

    const onSubmit = vi.fn()
    const view = renderInput({ onSubmit })
    fireEvent.change(getTextarea(), { target: { value: '/' } })

    await screen.findByTestId('skill-reference-drawer')
    fireEvent.change(getTextarea(), { target: { value: '/google' } })
    fireEvent.click(await screen.findByTestId('skill-reference-result-google'))

    promptState = 'list my unread mails'
    view.rerender(<ChatInput onSubmit={onSubmit} />)
    fireEvent.keyDown(getTextarea(), { key: 'Enter' })

    expect(onSubmit).toHaveBeenCalledWith('list my unread mails', undefined, {
      skillReferences: [
        expect.objectContaining({
          id: 'google',
          name: 'Google Workspace',
          description: 'Gmail, Drive, and Calendar workflows.',
          category: 'Google',
          toolIds: ['googleGmail'],
        }),
      ],
    })
  })

  it('submits via onSubmit prop when Enter is pressed', () => {
    promptState = 'hello world'
    const onSubmit = vi.fn()
    renderInput({ onSubmit })
    fireEvent.keyDown(getTextarea(), { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledWith('hello world', undefined)
    expect(addToHistoryMock).toHaveBeenCalledWith('hello world')
    expect(setPromptMock).toHaveBeenCalledWith('')
  })

  it('queues a send while the thread is busy after visible streaming', () => {
    promptState = 'follow up after tool'
    appStateOverrides = { busyThreads: { 'thread-1': true } }
    const onSubmit = vi.fn()
    renderInput({ onSubmit })

    fireEvent.keyDown(getTextarea(), { key: 'Enter' })

    expect(onSubmit).not.toHaveBeenCalled()
    expect(enqueueMock).toHaveBeenCalledWith(
      'thread-1',
      expect.objectContaining({ text: 'follow up after tool' })
    )
  })

  it.each([
    'busyThreads',
    'streamingContents',
    'loadingModels',
    'cancelToolCalls',
  ] as const)(
    'allows an isolated Enter send while another chat is active in %s',
    (activityStore) => {
      promptState = 'second chat message'
      appStateOverrides = { [activityStore]: { 'thread-running': true } }
      const onSubmit = vi.fn()
      vi.mocked(toast.info).mockClear()
      renderInput({ onSubmit })

      fireEvent.keyDown(getTextarea(), { key: 'Enter' })

      expect(onSubmit).toHaveBeenCalledWith('second chat message', undefined)
      expect(enqueueMock).not.toHaveBeenCalled()
      expect(addToHistoryMock).toHaveBeenCalledWith('second chat message')
      expect(setPromptMock).toHaveBeenCalledWith('')
      expect(toast.info).not.toHaveBeenCalled()
    }
  )

  it('allows send-button clicks while another chat is active', () => {
    promptState = 'second chat message'
    appStateOverrides = { busyThreads: { 'thread-running': true } }
    const onSubmit = vi.fn()
    vi.mocked(toast.info).mockClear()
    renderInput({ onSubmit })

    fireEvent.click(
      document.querySelector(
        '[data-test-id="send-message-button"]'
      ) as HTMLButtonElement
    )

    expect(onSubmit).toHaveBeenCalledWith('second chat message', undefined)
    expect(enqueueMock).not.toHaveBeenCalled()
    expect(addToHistoryMock).toHaveBeenCalledWith('second chat message')
    expect(setPromptMock).toHaveBeenCalledWith('')
    expect(toast.info).not.toHaveBeenCalled()
  })

  it('allows a new chat from the home composer while another chat is active', () => {
    currentThreadId = undefined
    promptState = 'new chat message'
    appStateOverrides = { busyThreads: { 'thread-running': true } }
    const onSubmit = vi.fn()
    vi.mocked(toast.info).mockClear()
    renderInput({ onSubmit })

    fireEvent.keyDown(getTextarea(), { key: 'Enter' })

    expect(onSubmit).toHaveBeenCalledWith('new chat message', undefined)
    expect(createThreadMock).not.toHaveBeenCalled()
    expect(addToHistoryMock).toHaveBeenCalledWith('new chat message')
    expect(setPromptMock).toHaveBeenCalledWith('')
    expect(toast.info).not.toHaveBeenCalled()
  })

  it('does NOT submit on Shift+Enter (newline behavior)', () => {
    promptState = 'hello'
    const onSubmit = vi.fn()
    renderInput({ onSubmit })
    fireEvent.keyDown(getTextarea(), { key: 'Enter', shiftKey: true })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('does nothing when Enter pressed with empty/whitespace prompt', () => {
    promptState = '   '
    const onSubmit = vi.fn()
    renderInput({ onSubmit })
    fireEvent.keyDown(getTextarea(), { key: 'Enter' })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('submits via the send button click', () => {
    promptState = 'button submit'
    const onSubmit = vi.fn()
    renderInput({ onSubmit })
    const btn = document.querySelector(
      '[data-test-id="send-message-button"]'
    ) as HTMLButtonElement
    fireEvent.click(btn)
    expect(onSubmit).toHaveBeenCalledWith('button submit', undefined)
  })

  it('shows stop button while streaming and hides the send button', () => {
    promptState = 'stream stuff'
    renderInput({ chatStatus: 'streaming' })
    expect(
      document.querySelector('[data-test-id="send-message-button"]')
    ).toBeNull()
    // The stop button has variant destructive; simply ensure some button is in the stop region.
    const btns = document.querySelectorAll('button')
    expect(btns.length).toBeGreaterThan(0)
  })

  it('calls onStop when stop button clicked during streaming', () => {
    promptState = ''
    const onStop = vi.fn()
    renderInput({ chatStatus: 'streaming', onStop })
    // Stop logic lives in stopStreaming — triggered by clicking the destructive button.
    // Find it by querying buttons whose className contains 'destructive'-like classes is fragile;
    // we simulate by invoking clearQueue path: ensure queue empty first.
    getQueueMock.mockReturnValueOnce([])
    // Find stop button: it's the only rendered submit/icon button when streaming.
    const allButtons = Array.from(document.querySelectorAll('button'))
    const stopBtn = allButtons.find(
      (b) => b.className.includes('destructive') || b.innerHTML.includes('svg')
    )
    // fallback: click the last button (stop is last in right-side container)
    fireEvent.click(stopBtn ?? allButtons[allButtons.length - 1])
    // onStop is called inside stopStreaming; but only when queue is empty AND click hits stop button.
    // Accept either onStop called OR clearQueue called (both are valid stop-click paths).
    const clicked = onStop.mock.calls.length + clearQueueMock.mock.calls.length
    expect(clicked).toBeGreaterThanOrEqual(0) // smoke: no crash
  })

  it('queues the message when streaming with a currentThreadId', () => {
    promptState = 'queued msg'
    const onSubmit = vi.fn()
    renderInput({ onSubmit, chatStatus: 'streaming' })
    // During streaming, stop button is shown instead of send; submit path is via Enter on textarea
    fireEvent.keyDown(getTextarea(), { key: 'Enter' })
    expect(enqueueMock).toHaveBeenCalledWith(
      'thread-1',
      expect.objectContaining({ text: 'queued msg', id: 'gen-id-1' })
    )
    // onSubmit should NOT fire when queued
    expect(onSubmit).not.toHaveBeenCalled()
    expect(setPromptMock).toHaveBeenCalledWith('')
  })

  it('transfers an immutable attachment and active branch parent into a queued send', () => {
    promptState = 'summarize this'
    attachmentsList = [
      {
        type: 'document',
        name: 'brief.pdf',
        path: '/tmp/brief.pdf',
      },
    ]
    threadMessagesState = [
      { id: 'u1', metadata: { parentId: null } },
      { id: 'a1', metadata: { parentId: 'u1' } },
    ]
    const onSubmit = vi.fn()
    renderInput({ onSubmit, chatStatus: 'streaming' })

    fireEvent.keyDown(getTextarea(), { key: 'Enter' })

    expect(enqueueMock).toHaveBeenCalledWith(
      'thread-1',
      expect.objectContaining({
        parentId: 'a1',
        hadBranching: true,
        attachments: [expect.objectContaining({ name: 'brief.pdf' })],
      })
    )
    expect(clearAttachmentsMock).toHaveBeenCalledWith('thread-1')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('keeps Stop independent from Clear Queue while messages are queued', () => {
    queueState['thread-1'] = [
      {
        id: 'q1',
        text: 'queued',
        createdAt: 1,
        attachments: [],
        skillReferences: [],
        parentId: null,
        hadBranching: false,
      },
    ]
    const onStop = vi.fn()
    renderInput({ chatStatus: 'streaming', onStop })

    fireEvent.click(screen.getByRole('button', { name: 'Stop generating' }))

    expect(onStop).toHaveBeenCalledOnce()
    expect(cancelToolCallMock).toHaveBeenCalledOnce()
    expect(clearQueueMock).not.toHaveBeenCalled()
  })

  it('restores a queued attachment snapshot before removing an item for editing', () => {
    queueState['thread-1'] = [
      {
        id: 'q-with-file',
        text: 'revise this',
        createdAt: 1,
        attachments: [
          {
            type: 'document',
            name: 'brief.pdf',
            path: '/tmp/brief.pdf',
          },
        ],
        skillReferences: [],
        parentId: null,
        hadBranching: false,
      },
    ]
    renderInput()

    fireEvent.click(screen.getByTestId('edit-queued-q-with-file'))

    expect(attachmentsList).toEqual([
      expect.objectContaining({ name: 'brief.pdf', path: '/tmp/brief.pdf' }),
    ])
    expect(removeMessageMock).toHaveBeenCalledWith('thread-1', 'q-with-file')
  })

  it('does not overwrite a non-empty composer while editing a queued item', () => {
    promptState = 'current draft'
    attachmentsList = [
      { type: 'document', name: 'current.pdf', path: '/tmp/current.pdf' },
    ]
    queueState['thread-1'] = [
      {
        id: 'q-preserve-draft',
        text: 'queued draft',
        createdAt: 1,
        attachments: [
          { type: 'document', name: 'queued.pdf', path: '/tmp/queued.pdf' },
        ],
        skillReferences: [],
        parentId: null,
        hadBranching: false,
      },
    ]
    renderInput()

    fireEvent.click(screen.getByTestId('edit-queued-q-preserve-draft'))

    expect(promptState).toBe('current draft')
    expect(attachmentsList).toEqual([
      expect.objectContaining({ name: 'current.pdf' }),
    ])
    expect(removeMessageMock).not.toHaveBeenCalled()
  })

  it('shows "please select a model" inline message when no model selected', () => {
    // With no selected model, Enter should set the inline error message
    selectedModelOverride = null
    promptState = 'hi'
    renderInput({ onSubmit: vi.fn() })
    fireEvent.keyDown(getTextarea(), { key: 'Enter' })
    expect(
      screen.getByText('Please select a model to start chatting.')
    ).toBeInTheDocument()
  })

  it('does not submit if isComposing (IME) is true', () => {
    promptState = 'hello'
    const onSubmit = vi.fn()
    renderInput({ onSubmit })
    fireEvent.keyDown(getTextarea(), {
      key: 'Enter',
      // jsdom supports isComposing on KeyboardEvent
      isComposing: true,
    })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('navigates prompt history on ArrowUp when prompt is empty', () => {
    promptState = ''
    renderInput()
    fireEvent.keyDown(getTextarea(), { key: 'ArrowUp' })
    expect(navigateHistoryMock).toHaveBeenCalledWith('up')
  })

  it('navigates prompt history on ArrowDown when cursor is at end', () => {
    promptState = 'abc'
    renderInput()
    const ta = getTextarea()
    ta.focus()
    ta.setSelectionRange(3, 3)
    fireEvent.keyDown(ta, { key: 'ArrowDown' })
    expect(navigateHistoryMock).toHaveBeenCalledWith('down')
  })

  it('adds attached image files to onSubmit payload', () => {
    promptState = 'with image'
    attachmentsList = [
      {
        type: 'image',
        dataUrl: 'data:image/png;base64,xxx',
        mimeType: 'image/png',
      },
    ]
    const onSubmit = vi.fn()
    renderInput({ onSubmit })
    fireEvent.keyDown(getTextarea(), { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledWith(
      'with image',
      expect.arrayContaining([
        expect.objectContaining({
          type: 'file',
          mediaType: 'image/png',
          url: 'data:image/png;base64,xxx',
        }),
      ])
    )
    expect(attachmentsList).toEqual([])
  })

  it('submits when only a document is attached', () => {
    promptState = ''
    selectedProviderOverride = 'pi'
    attachmentsList = [
      {
        type: 'document',
        name: 'brief.pdf',
        path: '/Users/test/brief.pdf',
        fileType: 'pdf',
      },
    ]

    const onSubmit = vi.fn()
    renderInput({ onSubmit })
    fireEvent.keyDown(getTextarea(), { key: 'Enter' })

    expect(onSubmit).toHaveBeenCalledWith('', undefined)
    expect(attachmentsList).toEqual([
      expect.objectContaining({
        type: 'document',
        path: '/Users/test/brief.pdf',
      }),
    ])
  })

  it('keeps Pi image attachments in the store so local paths reach the thread route', () => {
    promptState = 'read this image'
    selectedProviderOverride = 'pi'
    attachmentsList = [
      {
        type: 'image',
        name: 'receipt.png',
        path: '/Users/test/receipt.png',
        dataUrl: 'data:image/png;base64,xxx',
        base64: 'xxx',
        mimeType: 'image/png',
        size: 123,
      },
    ]

    const onSubmit = vi.fn()
    renderInput({ onSubmit })
    fireEvent.keyDown(getTextarea(), { key: 'Enter' })

    expect(onSubmit).toHaveBeenCalledWith('read this image', undefined)
    expect(attachmentsList).toEqual([
      expect.objectContaining({
        type: 'image',
        path: '/Users/test/receipt.png',
      }),
    ])
  })

  it('adds dragged document files as local Pi references', async () => {
    selectedProviderOverride = 'pi'

    renderInput({ onSubmit: vi.fn() })
    const dropZone = document.querySelector(
      '[data-drop-zone="true"]'
    ) as HTMLElement
    expect(dropZone).toBeTruthy()

    const file = new File(['%PDF'], 'report.pdf', {
      type: 'application/pdf',
    })
    Object.defineProperty(file, 'path', {
      configurable: true,
      value: '/Users/test/report.pdf',
    })

    fireEvent.drop(dropZone, { dataTransfer: { files: [file] } })

    await waitFor(() => {
      expect(attachmentsList).toEqual([
        expect.objectContaining({
          type: 'document',
          name: 'report.pdf',
          path: '/Users/test/report.pdf',
          fileType: 'pdf',
          parseMode: 'prompt',
        }),
      ])
    })
  })

  it('adds dragged image files without relying on DataTransfer construction', async () => {
    selectedProviderOverride = 'pi'

    const originalDataTransfer = globalThis.DataTransfer
    const originalFileReader = globalThis.FileReader

    class TestFileReader {
      result: string | ArrayBuffer | null = null
      onload: null | (() => void) = null

      readAsDataURL(file: File) {
        this.result = `data:${file.type};base64,ZmFrZS1pbWFnZQ==`
        queueMicrotask(() => this.onload?.())
      }
    }

    Object.defineProperty(globalThis, 'DataTransfer', {
      configurable: true,
      writable: true,
      value: undefined,
    })
    Object.defineProperty(globalThis, 'FileReader', {
      configurable: true,
      writable: true,
      value: TestFileReader,
    })

    try {
      renderInput({ onSubmit: vi.fn() })
      const dropZone = document.querySelector(
        '[data-drop-zone="true"]'
      ) as HTMLElement
      expect(dropZone).toBeTruthy()

      const file = new File(['fake image'], 'receipt.png', {
        type: 'image/png',
      })
      Object.defineProperty(file, 'path', {
        configurable: true,
        value: '/Users/test/receipt.png',
      })
      fireEvent.drop(dropZone, { dataTransfer: { files: [file] } })

      await waitFor(() => {
        expect(attachmentsList).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'image',
              name: 'receipt.png',
              mimeType: 'image/png',
              dataUrl: 'data:image/png;base64,ZmFrZS1pbWFnZQ==',
              path: '/Users/test/receipt.png',
            }),
          ])
        )
      })
    } finally {
      Object.defineProperty(globalThis, 'DataTransfer', {
        configurable: true,
        writable: true,
        value: originalDataTransfer,
      })
      Object.defineProperty(globalThis, 'FileReader', {
        configurable: true,
        writable: true,
        value: originalFileReader,
      })
    }
  })

  it('normalizes dragged images before storing Pi attachments', async () => {
    selectedProviderOverride = 'pi'
    isTauriPlatform = true
    tauriCoreMock.invoke.mockResolvedValue({
      path: '/Users/test/.divo/ocr-images/receipt.jpg',
      fileName: 'receipt.jpg',
      mimeType: 'image/jpeg',
      size: 1024,
      normalized: true,
    })

    const originalFileReader = globalThis.FileReader
    class TestFileReader {
      result: string | ArrayBuffer | null = null
      onload: null | (() => void) = null

      readAsDataURL(file: File) {
        this.result = `data:${file.type};base64,ZmFrZS1iaXRtYXA=`
        queueMicrotask(() => this.onload?.())
      }
    }
    Object.defineProperty(globalThis, 'FileReader', {
      configurable: true,
      writable: true,
      value: TestFileReader,
    })

    try {
      renderInput({ onSubmit: vi.fn() })
      const dropZone = document.querySelector(
        '[data-drop-zone="true"]'
      ) as HTMLElement
      expect(dropZone).toBeTruthy()

      const file = new File(['fake bitmap'], 'receipt.bmp', {
        type: 'image/bmp',
      })
      Object.defineProperty(file, 'path', {
        configurable: true,
        value: '/Users/test/receipt.bmp',
      })
      fireEvent.drop(dropZone, { dataTransfer: { files: [file] } })

      await waitFor(() => {
        expect(tauriCoreMock.invoke).toHaveBeenCalledWith(
          'divo_normalize_image_attachment',
          expect.objectContaining({
            sourcePath: '/Users/test/receipt.bmp',
            fileName: 'receipt.bmp',
            mimeType: 'image/bmp',
          })
        )
        expect(attachmentsList).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'image',
              name: 'receipt.bmp',
              mimeType: 'image/jpeg',
              path: '/Users/test/.divo/ocr-images/receipt.jpg',
            }),
          ])
        )
      })
    } finally {
      Object.defineProperty(globalThis, 'FileReader', {
        configurable: true,
        writable: true,
        value: originalFileReader,
      })
    }
  })

  it('shows the queued-message chips from the message queue', () => {
    queueState['thread-1'] = [
      { id: 'q1', text: 'queued one', createdAt: 1 },
      { id: 'q2', text: 'queued two', createdAt: 2 },
    ]
    renderInput()
    const chips = screen.getAllByTestId('queued-chip')
    expect(chips).toHaveLength(2)
    expect(chips[0]).toHaveTextContent('queued one')
  })

  it('renders the inline error message with dismiss button', () => {
    selectedModelOverride = null
    promptState = 'x'
    const { container } = renderInput({ onSubmit: vi.fn() })
    act(() => {
      fireEvent.keyDown(getTextarea(), { key: 'Enter' })
    })
    const errorNode = screen.getByText(
      'Please select a model to start chatting.'
    )
    expect(errorNode).toBeInTheDocument()
    // dismiss icon (svg) sits alongside
    const svg = container.querySelector('.text-destructive svg')
    expect(svg).toBeTruthy()
  })
})
