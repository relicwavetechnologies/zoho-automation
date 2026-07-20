/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import React from 'react'
import { processAttachmentsForSend } from '@/lib/attachmentProcessing'

// -----------------------------------------------------------------------------
// Hoisted shared state + mocks (needed because vi.mock factory runs first)
// -----------------------------------------------------------------------------
const h = vi.hoisted(() => {
  const mockSendMessage = vi.fn()
  const mockRegenerate = vi.fn()
  const mockStop = vi.fn()
  const mockAddToolOutput = vi.fn()
  const mockSetChatMessages = vi.fn()
  const mockUpdateRag = vi.fn()
  const mockSetContinueFromContent = vi.fn()

  const chatState: { messages: any[]; status: string; error: Error | null } = {
    messages: [],
    status: 'ready',
    error: null,
  }

  const threadsState: any = {
    threads: {
      'thread-1': {
        id: 'thread-1',
        title: 'My Thread',
        metadata: {},
        assistants: [],
        model: { id: 'gpt-x', provider: 'openai' },
      },
    },
    setCurrentThreadId: vi.fn(),
    updateThread: vi.fn(),
  }
  const useThreadsMock: any = (selector: any) => selector(threadsState)
  useThreadsMock.getState = () => threadsState

  const messagesState: any = {
    setMessages: vi.fn(),
    hydrateMessages: vi.fn().mockResolvedValue([]),
    addMessage: vi.fn(),
    updateMessage: vi.fn(),
    deleteMessage: vi.fn(),
    getMessages: vi.fn(() => []),
  }
  const useMessagesMock: any = (selector: any) => selector(messagesState)
  useMessagesMock.getState = () => messagesState

  const appStateState = {
    ragToolNames: new Set<string>(),
    mcpToolNames: new Set<string>(),
    setOomError: vi.fn(),
    setBackendError: vi.fn(),
    busyThreads: {} as Record<string, boolean>,
    piThreadRunStates: {} as Record<string, { runId: string; state: string }>,
    embeddingThreads: {} as Record<string, boolean>,
    setThreadBusy: vi.fn(),
    setThreadEmbedding: vi.fn(),
  }
  const useAppStateMock: any = (selector: any) => selector(appStateState)
  useAppStateMock.getState = () => appStateState

  const modelProviderState: any = {
    selectedModel: {
      id: 'gpt-x',
      capabilities: ['tools'],
      settings: {
        ctx_len: { controller_props: { value: 4096, max: 131072 } },
        auto_increase_ctx_len: { controller_props: { value: true } },
      },
    },
    selectedProvider: 'openai',
    getProviderByName: vi.fn((name: string) => ({
      provider: name,
      models: [
        {
          id: 'gpt-x',
          settings: {
            ctx_len: { controller_props: { value: 4096, max: 131072 } },
          },
        },
      ],
    })),
    updateProvider: vi.fn(),
  }
  const useModelProviderMock: any = (selector: any) =>
    selector(modelProviderState)
  useModelProviderMock.getState = () => modelProviderState

  const chatSessionsState: any = {
    sessions: {},
    getSessionData: vi.fn(() => ({ tools: [] })),
  }
  const useChatSessionsMock: any = (selector: any) =>
    selector(chatSessionsState)
  useChatSessionsMock.getState = () => chatSessionsState

  const attachmentsState: any = {
    getAttachments: vi.fn(() => []),
    clearAttachments: vi.fn(),
  }
  const useChatAttachmentsMock: any = (selector: any) =>
    selector(attachmentsState)
  useChatAttachmentsMock.getState = () => attachmentsState

  const useAttachmentsState: any = { enabled: true, parseMode: 'auto' }
  const useAttachmentsMock: any = (selector: any) =>
    selector(useAttachmentsState)
  useAttachmentsMock.getState = () => useAttachmentsState

  const toolAvailableState: any = {
    getDisabledToolsForThread: vi.fn(() => []),
  }
  const useToolAvailableMock: any = (selector: any) =>
    selector(toolAvailableState)
  useToolAvailableMock.getState = () => toolAvailableState

  const toolApprovalState: any = {
    showApprovalModal: vi.fn().mockResolvedValue(true),
    approveToolForThread: vi.fn(),
  }
  const useToolApprovalMock: any = (selector: any) =>
    selector(toolApprovalState)
  useToolApprovalMock.getState = () => toolApprovalState

  const agentModeState: any = { agentThreads: {} }
  const useAgentModeMock: any = (selector: any) => selector(agentModeState)
  useAgentModeMock.getState = () => agentModeState

  const messageQueueState: any = {
    getQueue: vi.fn(() => []),
    claimNext: vi.fn(() => undefined),
    acknowledge: vi.fn(),
    isDispatchable: vi.fn(() => true),
    discard: vi.fn(),
    release: vi.fn(),
    clearQueue: vi.fn(),
  }
  const useMessageQueueMock: any = (selector: any) =>
    selector ? selector(messageQueueState) : messageQueueState
  useMessageQueueMock.getState = () => messageQueueState

  return {
    mockSendMessage,
    mockRegenerate,
    mockStop,
    mockAddToolOutput,
    mockSetChatMessages,
    mockUpdateRag,
    mockSetContinueFromContent,
    chatState,
    threadsState,
    useThreadsMock,
    messagesState,
    useMessagesMock,
    appStateState,
    useAppStateMock,
    modelProviderState,
    useModelProviderMock,
    chatSessionsState,
    useChatSessionsMock,
    attachmentsState,
    useChatAttachmentsMock,
    useAttachmentsState,
    useAttachmentsMock,
    toolAvailableState,
    useToolAvailableMock,
    toolApprovalState,
    useToolApprovalMock,
    agentModeState,
    useAgentModeMock,
    messageQueueState,
    useMessageQueueMock,
  }
})

// -----------------------------------------------------------------------------
// Module mocks
// -----------------------------------------------------------------------------

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (config: any) => ({
    ...config,
    id: '/threads/$threadId',
  }),
  useParams: () => ({ threadId: 'thread-1' }),
  useSearch: () => ({ threadModel: undefined }),
}))

vi.mock('@/containers/HeaderPage', () => ({
  default: ({ children }: any) => (
    <div data-testid="header-page">{children}</div>
  ),
}))

vi.mock('@/containers/DivoWorkspaceSelector', () => ({
  default: () => <div data-testid="workspace-selector" />,
}))

vi.mock('@/containers/ChatInput', () => ({
  default: ({ onSubmit, onStop, chatStatus }: any) => (
    <div data-testid="chat-input">
      <span data-testid="chat-status">{chatStatus}</span>
      <button
        data-testid="chat-send"
        onClick={() => onSubmit('hello world', undefined)}
      >
        send
      </button>
      <button data-testid="chat-stop" onClick={() => onStop()}>
        stop
      </button>
    </div>
  ),
}))

vi.mock('@/containers/MessageItem', () => ({
  MessageItem: ({
    message,
    onRegenerate,
    onEdit,
    onDelete,
    versionInfo,
    onSwitchVersion,
  }: any) => (
    <div data-testid={`message-${message.id}`} data-role={message.role}>
      <span>{message.id}</span>
      {versionInfo && (
        <span data-testid={`version-${message.id}`}>
          {versionInfo.index}/{versionInfo.count}
        </span>
      )}
      <button
        data-testid={`prev-${message.id}`}
        onClick={() => onSwitchVersion?.(message.id, -1)}
      >
        prev
      </button>
      <button
        data-testid={`regen-${message.id}`}
        onClick={() => onRegenerate(message.id)}
      >
        regen
      </button>
      <button
        data-testid={`edit-${message.id}`}
        onClick={() => onEdit(message.id, 'edited text')}
      >
        edit
      </button>
      <button
        data-testid={`del-${message.id}`}
        onClick={() => onDelete(message.id)}
      >
        del
      </button>
    </div>
  ),
}))

vi.mock('@/components/ai-elements/conversation', () => ({
  Conversation: ({ children }: any) => <div>{children}</div>,
  ConversationContent: ({ children }: any) => <div>{children}</div>,
  ConversationPinSpacer: () => <div data-testid="pin-spacer" />,
  ConversationScrollButton: () => <div data-testid="scroll-btn" />,
}))

vi.mock('@/components/ai-elements/shimmer', () => ({
  Shimmer: ({ children }: any) => <div data-testid="shimmer">{children}</div>,
}))

vi.mock('@/components/PromptProgress', () => ({
  PromptProgress: () => <div data-testid="prompt-progress" />,
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, onClick }: any) => (
    <button onClick={onClick}>{children}</button>
  ),
}))

vi.mock('@tabler/icons-react', () => ({
  IconAlertCircle: () => <span />,
  IconRefresh: () => <span />,
}))

vi.mock('@/lib/utils', () => ({
  cn: (...classes: any[]) => classes.filter(Boolean).join(' '),
}))

vi.mock('@/lib/instructionTemplate', () => ({
  renderInstructions: (i: string) => `rendered:${i}`,
}))

vi.mock('@/lib/extension', () => ({
  ExtensionManager: {
    getInstance: () => ({
      get: () => ({
        listAttachmentsForProject: vi.fn().mockResolvedValue([]),
      }),
    }),
  },
}))

vi.mock('@/lib/messages', () => ({
  convertThreadMessagesToUIMessages: (msgs: any[]) =>
    msgs.map((m) => ({
      id: m.id,
      role: m.role,
      parts: [{ type: 'text', text: m.content?.[0]?.text?.value ?? '' }],
    })),
  extractContentPartsFromUIMessage: (msg: any) =>
    msg.parts
      .filter((p: any) => p.type === 'text')
      .map((p: any) => ({
        type: 'text',
        text: { value: p.text, annotations: [] },
      })),
  uiMessageHasMeaningfulContent: (msg: any) =>
    !!msg?.parts?.some((p: any) => p.type === 'text' && p.text?.trim()),
}))

vi.mock('@/lib/completion', () => ({
  newUserThreadContent: (
    threadId: string,
    text: string,
    _a: any,
    id: string
  ) => ({
    id,
    thread_id: threadId,
    role: 'user',
    content: [{ type: 'text', text: { value: text, annotations: [] } }],
    metadata: {},
  }),
}))

vi.mock('@/lib/attachmentProcessing', () => ({
  processAttachmentsForSend: vi
    .fn()
    .mockResolvedValue({
      processedAttachments: [],
      hasEmbeddedDocuments: false,
    }),
}))

vi.mock('@/lib/thread-title-summarizer', () => ({
  generateThreadTitle: vi.fn().mockResolvedValue('Short title'),
}))

vi.mock('@/types/attachment', () => ({
  createImageAttachment: (x: any) => ({ type: 'image', ...x }),
}))

vi.mock('ai', () => ({
  generateId: () => 'gen-id',
  lastAssistantMessageIsCompleteWithToolCalls: () => false,
}))

vi.mock('zustand/react/shallow', () => ({
  useShallow: (fn: any) => fn,
}))

vi.mock('@/hooks/use-chat', () => ({
  useChat: (_args: any) => {
    ;(h as any).capturedOnFinish = _args?.onFinish
    ;(h as any).capturedOnError = _args?.onError
    return {
      messages: h.chatState.messages,
      status: h.chatState.status,
      error: h.chatState.error,
      sendMessage: h.mockSendMessage,
      regenerate: h.mockRegenerate,
      setMessages: h.mockSetChatMessages,
      stop: h.mockStop,
      addToolOutput: h.mockAddToolOutput,
      updateRagToolsAvailability: h.mockUpdateRag,
      setContinueFromContent: h.mockSetContinueFromContent,
    }
  },
}))

vi.mock('@/hooks/useThreads', () => ({ useThreads: h.useThreadsMock }))
vi.mock('@/hooks/useMessages', () => ({ useMessages: h.useMessagesMock }))
vi.mock('@/hooks/useTools', () => ({ useTools: vi.fn() }))
vi.mock('@/hooks/useAppState', () => ({ useAppState: h.useAppStateMock }))
vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: h.useModelProviderMock,
}))
vi.mock('@/stores/chat-session-store', () => ({
  useChatSessions: h.useChatSessionsMock,
}))
vi.mock('@/hooks/useChatAttachments', () => ({
  useChatAttachments: h.useChatAttachmentsMock,
  NEW_THREAD_ATTACHMENT_KEY: '__new-thread__',
}))
vi.mock('@/hooks/useAttachments', () => ({
  useAttachments: h.useAttachmentsMock,
}))
vi.mock('@/hooks/useToolAvailable', () => ({
  useToolAvailable: h.useToolAvailableMock,
}))
vi.mock('@/hooks/useToolApproval', () => ({
  useToolApproval: h.useToolApprovalMock,
}))
vi.mock('@/hooks/useAgentMode', () => ({ useAgentMode: h.useAgentModeMock }))
vi.mock('@/stores/message-queue-store', () => ({
  useMessageQueue: h.useMessageQueueMock,
}))

vi.mock('@/hooks/useAutoScroll', () => ({
  useAutoScroll: () => ({
    containerRef: { current: null },
    isAtBottom: true,
    handleScroll: vi.fn(),
    scrollToBottom: vi.fn(),
    forceScrollToBottom: vi.fn(),
    reset: vi.fn(),
  }),
}))

vi.mock('@janhq/core', () => ({
  MessageStatus: { Ready: 'ready' },
  ChatCompletionRole: { Assistant: 'assistant', User: 'user' },
  ContentType: { Text: 'text' },
  ExtensionTypeEnum: { VectorDB: 'vectorDB' },
  VectorDBExtension: class {},
}))

vi.mock('@/constants/chat', () => ({
  SESSION_STORAGE_PREFIX: { INITIAL_MESSAGE: 'initial-message-' },
}))

vi.mock('@/utils/error', () => ({
  OUT_OF_CONTEXT_SIZE: 'OUT_OF_CONTEXT_SIZE',
}))

// -----------------------------------------------------------------------------
// Import component AFTER mocks
// -----------------------------------------------------------------------------
import { Route } from '../$threadId'

const renderComponent = () => {
  const Component = Route.component as React.ComponentType
  return render(<Component />)
}

describe('ThreadDetail route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.mockSendMessage.mockImplementation((_message: any, options?: any) => {
      options?.body?.__divoOnStreamAccepted?.()
      return Promise.resolve()
    })
    h.chatState.messages = []
    h.chatState.status = 'ready'
    h.chatState.error = null
    h.threadsState.threads['thread-1'] = {
      id: 'thread-1',
      title: 'My Thread',
      metadata: {},
      assistants: [],
      model: { id: 'gpt-x', provider: 'openai' },
    }
    h.threadsState.setCurrentThreadId = vi.fn()
    h.threadsState.updateThread = vi.fn()
    h.messagesState.getMessages = vi.fn(() => [
      {
        id: 'u1',
        role: 'user',
        content: [{ type: 'text', text: { value: 'hi', annotations: [] } }],
      },
      {
        id: 'a1',
        role: 'assistant',
        content: [{ type: 'text', text: { value: 'hello', annotations: [] } }],
      },
    ])
    h.messagesState.addMessage = vi.fn()
    h.messagesState.updateMessage = vi.fn()
    h.messagesState.deleteMessage = vi.fn()
    h.messagesState.setMessages = vi.fn()
    h.chatSessionsState.getSessionData = vi.fn(() => ({ tools: [] }))
    h.attachmentsState.getAttachments = vi.fn(() => [])
    h.attachmentsState.clearAttachments = vi.fn()
    h.messageQueueState.getQueue = vi.fn(() => [])
    h.messageQueueState.claimNext = vi.fn(() => undefined)
    h.messageQueueState.acknowledge = vi.fn(() => {
      h.messageQueueState.claimNext = vi.fn(() => undefined)
    })
    h.messageQueueState.isDispatchable = vi.fn(() => true)
    h.messageQueueState.discard = vi.fn()
    h.messageQueueState.release = vi.fn()
    h.messageQueueState.clearQueue = vi.fn()
    h.agentModeState.agentThreads = {}
    h.modelProviderState.selectedProvider = 'openai'
    h.appStateState.oomError = undefined
    h.appStateState.busyThreads = {}
    h.appStateState.piThreadRunStates = {}
    sessionStorage.clear()
  })

  it('validateSearch returns threadModel from search params', () => {
    const searchModel = { id: 'm1', provider: 'p1' }
    const result = (Route as any).validateSearch({ threadModel: searchModel })
    expect(result.threadModel).toEqual(searchModel)
  })

  it('validateSearch handles missing threadModel', () => {
    const result = (Route as any).validateSearch({})
    expect(result.threadModel).toBeUndefined()
  })

  it('renders header, workspace selector, and chat input', () => {
    renderComponent()
    expect(screen.getByTestId('header-page')).toBeInTheDocument()
    expect(screen.getByTestId('workspace-selector')).toBeInTheDocument()
    expect(screen.getByTestId('chat-input')).toBeInTheDocument()
    expect(screen.getByTestId('chat-status')).toHaveTextContent('ready')
  })

  it('sets current thread id on mount and resets on unmount', () => {
    const { unmount } = renderComponent()
    expect(h.threadsState.setCurrentThreadId).toHaveBeenCalledWith('thread-1')
    unmount()
    expect(h.threadsState.setCurrentThreadId).toHaveBeenLastCalledWith(
      undefined
    )
  })

  it('renders messages passed through useChat', () => {
    h.chatState.messages = [
      { id: 'm-a', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { id: 'm-b', role: 'assistant', parts: [{ type: 'text', text: 'yo' }] },
    ]
    renderComponent()
    expect(screen.getByTestId('message-m-a')).toBeInTheDocument()
    expect(screen.getByTestId('message-m-b')).toBeInTheDocument()
  })

  it('settles a completed Pi chat when a cached SDK status is still streaming', () => {
    h.chatState.status = 'streaming'
    h.chatState.messages = [
      {
        id: 'assistant-complete',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Final answer' }],
        metadata: { piTraceTimeline: true },
      },
    ]

    renderComponent()

    expect(screen.getByTestId('chat-status')).toHaveTextContent('ready')
  })

  it('keeps an active Pi chat streaming while its runtime owns the thread', () => {
    h.chatState.status = 'streaming'
    h.chatState.messages = [
      {
        id: 'assistant-active',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Working on it' }],
        metadata: { piTraceTimeline: true },
      },
    ]
    h.appStateState.busyThreads = { 'thread-1': true }

    renderComponent()

    expect(screen.getByTestId('chat-status')).toHaveTextContent('streaming')
  })

  it('checkpoints meaningful Pi output while its runtime owns the thread', async () => {
    h.chatState.status = 'streaming'
    h.chatState.messages = [
      {
        id: 'assistant-checkpoint',
        role: 'assistant',
        parts: [{ type: 'text', text: 'The saved partial answer' }],
        metadata: { piTraceTimeline: true },
      },
    ]
    h.appStateState.busyThreads = { 'thread-1': true }

    renderComponent()

    await waitFor(() => {
      expect(h.messagesState.addMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'assistant-checkpoint',
          metadata: expect.objectContaining({
            piTraceTimeline: true,
            piStreamCheckpoint: { state: 'in_progress' },
          }),
        })
      )
    })
  })

  it('submits user text via ChatInput -> sendMessage', async () => {
    renderComponent()
    await act(async () => {
      screen.getByTestId('chat-send').click()
    })
    await waitFor(() => {
      expect(h.mockSendMessage).toHaveBeenCalled()
    })
    expect(h.messagesState.addMessage).toHaveBeenCalled()
  })

  it('sends Pi document references without legacy attachment ingestion', async () => {
    h.modelProviderState.selectedProvider = 'pi'
    h.attachmentsState.getAttachments = vi.fn(() => [
      {
        type: 'document',
        name: 'brief.pdf',
        path: '/Users/test/brief.pdf',
        fileType: 'pdf',
      },
    ])

    renderComponent()
    await act(async () => {
      screen.getByTestId('chat-send').click()
    })

    await waitFor(() => {
      expect(h.mockSendMessage).toHaveBeenCalled()
    })
    expect(processAttachmentsForSend).not.toHaveBeenCalled()
    expect(h.attachmentsState.clearAttachments).toHaveBeenCalledWith('thread-1')
  })

  it('invokes stop when ChatInput calls onStop', () => {
    renderComponent()
    screen.getByTestId('chat-stop').click()
    expect(h.mockStop).toHaveBeenCalled()
  })

  it('regenerate from a user message calls regenerate with its id', () => {
    h.chatState.messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'hello' }] },
    ]
    renderComponent()
    screen.getByTestId('regen-u1').click()
    expect(h.mockRegenerate).toHaveBeenCalledWith({ messageId: 'u1' })
  })

  it('regenerate from an assistant message keeps the prior version (no delete)', () => {
    h.chatState.messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'hello' }] },
    ]
    renderComponent()
    screen.getByTestId('regen-a1').click()
    // Versioning: the old reply is preserved, parent links are backfilled.
    expect(h.messagesState.deleteMessage).not.toHaveBeenCalled()
    expect(h.messagesState.updateMessage).toHaveBeenCalled()
    expect(h.mockRegenerate).toHaveBeenCalledWith({ messageId: 'a1' })
  })

  it('edit on a user message forks a new version and regenerates', () => {
    h.chatState.messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'hello' }] },
    ]
    renderComponent()
    screen.getByTestId('edit-u1').click()
    // A new sibling version is added; the original branch is not deleted.
    expect(h.messagesState.addMessage).toHaveBeenCalled()
    expect(h.messagesState.updateMessage).toHaveBeenCalled()
    expect(h.mockSetChatMessages).toHaveBeenCalled()
    expect(h.messagesState.deleteMessage).not.toHaveBeenCalled()
    expect(h.mockRegenerate).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: expect.any(String) })
    )
  })

  it('edit on an assistant message updates without regenerating', () => {
    h.chatState.messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'hello' }] },
    ]
    renderComponent()
    screen.getByTestId('edit-a1').click()
    expect(h.messagesState.updateMessage).toHaveBeenCalled()
    expect(h.mockRegenerate).not.toHaveBeenCalled()
  })

  it('shows a version chip and switches branches without regenerating', () => {
    const branched = [
      {
        id: 'u1',
        role: 'user',
        created_at: 1,
        content: [{ type: 'text', text: { value: 'hi', annotations: [] } }],
        metadata: { parentId: null },
      },
      {
        id: 'a1a',
        role: 'assistant',
        created_at: 2,
        content: [{ type: 'text', text: { value: 'v1', annotations: [] } }],
        metadata: { parentId: 'u1' },
      },
      {
        id: 'a1b',
        role: 'assistant',
        created_at: 3,
        content: [{ type: 'text', text: { value: 'v2', annotations: [] } }],
        metadata: { parentId: 'u1' },
      },
    ]
    h.messagesState.messages = { 'thread-1': branched }
    h.messagesState.getMessages = vi.fn(() => branched)
    h.chatState.messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { id: 'a1b', role: 'assistant', parts: [{ type: 'text', text: 'v2' }] },
    ]
    renderComponent()
    // The active (newest) reply shows as version 2 of 2.
    expect(screen.getByTestId('version-a1b').textContent).toBe('2/2')
    screen.getByTestId('prev-a1b').click()
    // Switching pins the parent's active child and re-renders, no regeneration.
    expect(h.messagesState.updateMessage).toHaveBeenCalled()
    expect(h.mockSetChatMessages).toHaveBeenCalled()
    expect(h.mockRegenerate).not.toHaveBeenCalled()
  })

  it('clears an active banner error when switching versions so a healthy assistant is not hidden', () => {
    // A prior turn left a router OOM banner active. Without clearing it on
    // switch, the render filter blanks the last assistant of whatever branch we
    // land on, leaving only user messages visible.
    h.modelProviderState.selectedProvider = 'llamacpp'
    h.appStateState.oomError = 'router crashed'
    const branched = [
      {
        id: 'u1',
        role: 'user',
        created_at: 1,
        content: [{ type: 'text', text: { value: 'hi', annotations: [] } }],
        metadata: { parentId: null },
      },
      {
        id: 'a1a',
        role: 'assistant',
        created_at: 2,
        content: [{ type: 'text', text: { value: 'v1', annotations: [] } }],
        metadata: { parentId: 'u1' },
      },
      {
        id: 'a1b',
        role: 'assistant',
        created_at: 3,
        content: [{ type: 'text', text: { value: 'v2', annotations: [] } }],
        metadata: { parentId: 'u1' },
      },
    ]
    h.messagesState.messages = { 'thread-1': branched }
    h.messagesState.getMessages = vi.fn(() => branched)
    // a1b is rendered mid-list (a trailing user turn keeps it off the
    // last-message filter) so its version nav stays clickable.
    h.chatState.messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
      { id: 'a1b', role: 'assistant', parts: [{ type: 'text', text: 'v2' }] },
      { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'more' }] },
    ]
    renderComponent()
    screen.getByTestId('prev-a1b').click()
    expect(h.appStateState.setOomError).toHaveBeenCalledWith(undefined)
    expect(h.mockRegenerate).not.toHaveBeenCalled()
  })

  it('onFinish links a new assistant to the active user turn in a branched thread (never null parent)', () => {
    // Regression for #8357: once a thread is branched, a lost pending-parent ref
    // must not persist the assistant with parentId:null (which computeActivePath
    // drops as a phantom root, leaving "user messages in a row").
    const branched = [
      {
        id: 'u1',
        role: 'user',
        created_at: 1,
        content: [{ type: 'text', text: { value: 'hi', annotations: [] } }],
        metadata: { parentId: null },
      },
      {
        id: 'a1',
        role: 'assistant',
        created_at: 2,
        content: [{ type: 'text', text: { value: 'r1', annotations: [] } }],
        metadata: { parentId: 'u1' },
      },
      {
        id: 'u2',
        role: 'user',
        created_at: 3,
        content: [{ type: 'text', text: { value: 'again', annotations: [] } }],
        metadata: { parentId: 'a1' },
      },
    ]
    h.messagesState.getMessages = vi.fn(() => branched)
    renderComponent()

    act(() => {
      ;(h as any).capturedOnFinish({
        message: {
          id: 'a2',
          role: 'assistant',
          parts: [{ type: 'text', text: 'reply for u2' }],
          metadata: {},
        },
        isAbort: false,
      })
    })

    const added = h.messagesState.addMessage.mock.calls.map((c: any[]) => c[0])
    const persisted = added.find((m: any) => m.id === 'a2')
    expect(persisted).toBeTruthy()
    expect(persisted.metadata.parentId).toBe('u2')
    expect(persisted.metadata.parentId).not.toBeNull()
  })

  it('persists meaningful Pi partial output as interrupted when the user stops it', () => {
    h.chatState.status = 'streaming'
    renderComponent()

    screen.getByTestId('chat-stop').click()
    expect(h.mockStop).toHaveBeenCalledOnce()

    act(() => {
      ;(h as any).capturedOnFinish({
        message: {
          id: 'a-stopped',
          role: 'assistant',
          parts: [{ type: 'text', text: 'Partial answer' }],
          metadata: { piTraceTimeline: true },
        },
        isAbort: true,
      })
    })

    const persisted = h.messagesState.addMessage.mock.calls
      .map((c: any[]) => c[0])
      .find((m: any) => m.id === 'a-stopped')
    expect(persisted).toMatchObject({
      metadata: {
        piTraceTimeline: true,
        interrupted: true,
        interruption: { state: 'interrupted', reason: 'user_stop' },
      },
    })
    // A user stop is terminal: do not automatically run tools or regenerate.
    expect(h.mockAddToolOutput).not.toHaveBeenCalled()
    expect(h.mockRegenerate).not.toHaveBeenCalled()
  })

  it('does not persist an empty assistant placeholder after user stop', () => {
    h.chatState.status = 'streaming'
    renderComponent()

    screen.getByTestId('chat-stop').click()
    act(() => {
      ;(h as any).capturedOnFinish({
        message: {
          id: 'a-empty-stopped',
          role: 'assistant',
          parts: [{ type: 'text', text: '   ' }],
          metadata: { piTraceTimeline: true },
        },
        isAbort: true,
      })
    })

    expect(
      h.messagesState.addMessage.mock.calls.some(
        ([message]: any[]) => message.id === 'a-empty-stopped'
      )
    ).toBe(false)
  })

  it('keeps an interrupted branch when editing the original user message', () => {
    const persisted: any[] = [
      {
        id: 'u1',
        role: 'user',
        created_at: 1,
        content: [
          { type: 'text', text: { value: 'original', annotations: [] } },
        ],
        metadata: { parentId: null },
      },
    ]
    h.messagesState.getMessages = vi.fn(() => persisted)
    h.messagesState.addMessage = vi.fn((message: any) =>
      persisted.push(message)
    )
    h.chatState.messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'original' }] },
    ]
    h.chatState.status = 'streaming'
    renderComponent()

    screen.getByTestId('chat-stop').click()
    act(() => {
      ;(h as any).capturedOnFinish({
        message: {
          id: 'a-interrupted',
          role: 'assistant',
          parts: [{ type: 'text', text: 'partial result' }],
          metadata: { piTraceTimeline: true },
        },
        isAbort: true,
      })
    })
    screen.getByTestId('edit-u1').click()

    expect(persisted.find((m) => m.id === 'a-interrupted')).toMatchObject({
      metadata: { interrupted: true, parentId: 'u1' },
    })
    const edited = persisted.find(
      (m) => m.id !== 'u1' && m.id !== 'a-interrupted'
    )
    expect(edited).toMatchObject({
      role: 'user',
      metadata: { parentId: null },
    })
    expect(h.messagesState.deleteMessage).not.toHaveBeenCalled()
    expect(h.mockRegenerate).toHaveBeenCalledWith({ messageId: edited.id })
  })

  it('delete removes message from store and chat list', () => {
    h.chatState.messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
    ]
    renderComponent()
    screen.getByTestId('del-u1').click()
    expect(h.messagesState.deleteMessage).toHaveBeenCalledWith('thread-1', 'u1')
    expect(h.mockSetChatMessages).toHaveBeenCalled()
  })

  it('shows PromptProgress while status is submitted', () => {
    h.chatState.status = 'submitted'
    renderComponent()
    expect(screen.getByTestId('prompt-progress')).toBeInTheDocument()
  })

  it('keeps PromptProgress visible after streaming starts but before Pi emits visible activity', () => {
    h.chatState.status = 'streaming'
    h.chatState.messages = [
      {
        id: 'assistant-start',
        role: 'assistant',
        parts: [],
        metadata: { piTraceTimeline: true },
      },
    ]
    renderComponent()
    expect(screen.getByTestId('prompt-progress')).toBeInTheDocument()
  })

  it('hides PromptProgress once visible assistant activity arrives', () => {
    h.chatState.status = 'streaming'
    h.chatState.messages = [
      {
        id: 'assistant-working',
        role: 'assistant',
        parts: [{ type: 'reasoning', text: 'Reading the request' }],
        metadata: { piTraceTimeline: true },
      },
    ]
    renderComponent()
    expect(screen.queryByTestId('prompt-progress')).not.toBeInTheDocument()
  })

  it('processes an initial message from sessionStorage on mount', async () => {
    sessionStorage.setItem(
      'initial-message-thread-1',
      JSON.stringify({ text: 'hello from storage' })
    )
    renderComponent()
    await waitFor(() => {
      expect(h.mockSendMessage).toHaveBeenCalled()
    })
    expect(sessionStorage.getItem('initial-message-thread-1')).toBeNull()
  })

  it('preserves the queue on unmount so navigation does not discard user intent', () => {
    const { unmount } = renderComponent()
    unmount()
    expect(h.messageQueueState.clearQueue).not.toHaveBeenCalled()
  })

  it('retains a queued message when its captured branch parent was deleted', async () => {
    h.messageQueueState.claimNext = vi.fn(() => ({
      claimId: 'claim-1',
      message: {
        id: 'queued-1',
        text: 'keep this branch',
        createdAt: 1,
        attachments: [],
        skillReferences: [],
        parentId: 'deleted-parent',
        hadBranching: true,
      },
    }))

    renderComponent()

    await waitFor(() => {
      expect(h.messageQueueState.release).toHaveBeenCalledWith(
        'thread-1',
        expect.objectContaining({ claimId: 'claim-1' }),
        expect.objectContaining({
          code: 'branch_parent_missing',
          message: expect.stringContaining('original branch'),
        })
      )
    })
    expect(h.mockSendMessage).not.toHaveBeenCalled()
    expect(h.messageQueueState.acknowledge).not.toHaveBeenCalled()
  })

  it('replays queued attachments and skill references through the normal submission path', async () => {
    h.messageQueueState.claimNext = vi.fn(() => ({
      claimId: 'claim-attachments',
      message: {
        id: 'queued-attachments',
        text: 'inspect this image',
        createdAt: 1,
        attachments: [
          {
            type: 'image',
            name: 'diagram.png',
            mimeType: 'image/png',
            base64: 'ZmlsZQ==',
            dataUrl: 'data:image/png;base64,ZmlsZQ==',
          },
        ],
        skillReferences: [
          {
            id: 'vision',
            name: 'Vision',
            description: 'Inspect images',
            category: 'Research',
            toolIds: ['inspect-image'],
          },
        ],
        parentId: 'a1',
        hadBranching: false,
      },
    }))

    renderComponent()

    await waitFor(() => {
      expect(processAttachmentsForSend).toHaveBeenCalledWith(
        expect.objectContaining({
          attachments: [expect.objectContaining({ name: 'diagram.png' })],
        })
      )
      expect(h.mockSendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          parts: expect.arrayContaining([
            expect.objectContaining({
              type: 'file',
              mediaType: 'image/png',
            }),
          ]),
          metadata: expect.objectContaining({
            divoSkillReferences: [expect.objectContaining({ id: 'vision' })],
          }),
        }),
        expect.objectContaining({
          body: expect.objectContaining({
            __divoOnStreamAccepted: expect.any(Function),
          }),
        })
      )
      expect(h.messageQueueState.acknowledge).toHaveBeenCalledWith(
        'thread-1',
        expect.objectContaining({ claimId: 'claim-attachments' })
      )
    })
  })

  it('retains the captured parent when the active branch changes before replay', async () => {
    const branchedMessages: any[] = [
      {
        id: 'u1',
        role: 'user',
        metadata: { parentId: null, activeChildId: 'a-active-now' },
        content: [{ type: 'text', text: { value: 'root' } }],
      },
      {
        id: 'a-captured',
        role: 'assistant',
        metadata: { parentId: 'u1' },
        content: [{ type: 'text', text: { value: 'captured' } }],
      },
      {
        id: 'a-active-now',
        role: 'assistant',
        metadata: { parentId: 'u1' },
        content: [{ type: 'text', text: { value: 'other branch' } }],
      },
    ]
    h.messagesState.getMessages = vi.fn(() => branchedMessages)
    h.messagesState.addMessage = vi.fn((message: any) => {
      branchedMessages.push(message)
    })
    h.messagesState.updateMessage = vi.fn((message: any) => {
      const index = branchedMessages.findIndex((current) => current.id === message.id)
      if (index >= 0) branchedMessages[index] = message
    })
    let sdkMessages: any[] = []
    h.mockSetChatMessages = vi.fn((messages: any[]) => {
      sdkMessages = messages
    })
    h.mockSendMessage.mockImplementation((message: any, options?: any) => {
      sdkMessages = [...sdkMessages, message]
      options?.body?.__divoOnStreamAccepted?.()
      return Promise.resolve()
    })
    h.messageQueueState.claimNext = vi.fn(() => ({
      claimId: 'claim-branch',
      message: {
        id: 'queued-branch',
        text: 'continue the original branch',
        createdAt: 1,
        attachments: [],
        skillReferences: [],
        parentId: 'a-captured',
        hadBranching: true,
      },
    }))

    renderComponent()

    await waitFor(() => {
      expect(h.messagesState.addMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ parentId: 'a-captured' }),
        })
      )
      expect(h.messagesState.updateMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'a-captured',
          metadata: expect.objectContaining({ activeChildId: 'gen-id' }),
        })
      )
      expect(h.mockSetChatMessages).toHaveBeenCalledWith(
        expect.not.arrayContaining([expect.objectContaining({ id: 'gen-id' })])
      )
      expect(sdkMessages.filter((message) => message.id === 'gen-id')).toHaveLength(1)
      expect(
        sdkMessages.filter(
          (message) => message.parts?.[0]?.text === 'continue the original branch'
        )
      ).toHaveLength(1)
      expect(h.messageQueueState.acknowledge).toHaveBeenCalled()
    })
  })

  it('cancels a claimed item during attachment preprocessing before dispatch', async () => {
    let resolveProcessing: ((value: any) => void) | undefined
    ;(processAttachmentsForSend as any).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveProcessing = resolve
        })
    )
    h.messageQueueState.isDispatchable = vi
      .fn()
      .mockReturnValueOnce(true)
      .mockReturnValue(false)
    h.messageQueueState.claimNext = vi.fn(() => ({
      claimId: 'claim-cancel',
      message: {
        id: 'queued-cancel',
        text: 'do not send',
        createdAt: 1,
        attachments: [
          { type: 'document', name: 'brief.pdf', path: '/tmp/brief.pdf' },
        ],
        skillReferences: [],
        parentId: 'a1',
        hadBranching: false,
      },
    }))

    renderComponent()
    await waitFor(() => expect(resolveProcessing).toBeDefined())
    resolveProcessing?.({ processedAttachments: [], hasEmbeddedDocuments: false })

    await waitFor(() => {
      expect(h.messageQueueState.discard).toHaveBeenCalledWith(
        'thread-1',
        expect.objectContaining({ claimId: 'claim-cancel' })
      )
    })
    expect(h.mockSendMessage).not.toHaveBeenCalled()
    expect(h.messageQueueState.release).not.toHaveBeenCalled()
  })

  it('keeps an accepted queued user turn when the stream later rejects', async () => {
    h.mockSendMessage.mockImplementationOnce((_message: any, options?: any) => {
      options?.body?.__divoOnStreamAccepted?.()
      return Promise.reject(new Error('stream interrupted'))
    })
    h.messageQueueState.claimNext = vi.fn(() => ({
      claimId: 'claim-late-error',
      message: {
        id: 'queued-late-error',
        text: 'accepted turn',
        createdAt: 1,
        attachments: [],
        skillReferences: [],
        parentId: 'a1',
        hadBranching: false,
      },
    }))

    renderComponent()

    await waitFor(() => {
      expect(h.messageQueueState.acknowledge).toHaveBeenCalledWith(
        'thread-1',
        expect.objectContaining({ claimId: 'claim-late-error' })
      )
    })
    expect(h.messagesState.deleteMessage).not.toHaveBeenCalled()
    expect(h.messageQueueState.release).not.toHaveBeenCalled()
  })

  it('releases an unaccepted transport failure for retry', async () => {
    // AI SDK resolves handled transport errors; absence of the explicit
    // transport callback is what proves this request was never accepted.
    h.mockSendMessage.mockResolvedValueOnce(undefined)
    h.messageQueueState.claimNext = vi.fn(() => ({
      claimId: 'claim-preflight-error',
      message: {
        id: 'queued-preflight-error',
        text: 'retry this',
        createdAt: 1,
        attachments: [],
        skillReferences: [],
        parentId: 'a1',
        hadBranching: false,
      },
    }))

    renderComponent()

    await waitFor(() => {
      expect(h.messageQueueState.release).toHaveBeenCalledWith(
        'thread-1',
        expect.objectContaining({ claimId: 'claim-preflight-error' }),
        expect.objectContaining({ code: 'submission_failed' })
      )
    })
    expect(h.messagesState.deleteMessage).toHaveBeenCalledWith('thread-1', 'gen-id')
    expect(h.messageQueueState.acknowledge).not.toHaveBeenCalled()
  })

  it('retains the queue when the captured parent is deleted during preprocessing', async () => {
    let resolveProcessing: ((value: any) => void) | undefined
    const messages: any[] = [
      { id: 'u1', role: 'user', content: [] },
      { id: 'a1', role: 'assistant', content: [] },
    ]
    h.messagesState.getMessages = vi.fn(() => messages)
    ;(processAttachmentsForSend as any).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveProcessing = resolve
        })
    )
    h.messageQueueState.claimNext = vi.fn(() => ({
      claimId: 'claim-parent-race',
      message: {
        id: 'queued-parent-race',
        text: 'branch race',
        createdAt: 1,
        attachments: [
          { type: 'document', name: 'brief.pdf', path: '/tmp/brief.pdf' },
        ],
        skillReferences: [],
        parentId: 'a1',
        hadBranching: false,
      },
    }))

    renderComponent()
    await waitFor(() => expect(resolveProcessing).toBeDefined())
    messages.splice(messages.findIndex((message) => message.id === 'a1'), 1)
    resolveProcessing?.({ processedAttachments: [], hasEmbeddedDocuments: false })

    await waitFor(() => {
      expect(h.messageQueueState.release).toHaveBeenCalledWith(
        'thread-1',
        expect.objectContaining({ claimId: 'claim-parent-race' }),
        expect.objectContaining({ code: 'branch_parent_missing' })
      )
    })
    expect(h.mockSendMessage).not.toHaveBeenCalled()
  })

  it('retains a queued head when attachment preprocessing fails', async () => {
    ;(processAttachmentsForSend as any).mockRejectedValueOnce(
      new Error('Attachment preprocessing failed')
    )
    h.messageQueueState.claimNext = vi.fn(() => ({
      claimId: 'claim-preprocess',
      message: {
        id: 'queued-preprocess',
        text: 'read this file',
        createdAt: 1,
        attachments: [
          { type: 'document', name: 'brief.pdf', path: '/tmp/brief.pdf' },
        ],
        skillReferences: [],
        parentId: 'a1',
        hadBranching: false,
      },
    }))

    renderComponent()

    await waitFor(() => {
      expect(h.messageQueueState.release).toHaveBeenCalledWith(
        'thread-1',
        expect.objectContaining({ claimId: 'claim-preprocess' }),
        expect.objectContaining({
          code: 'submission_failed',
          message: 'Attachment preprocessing failed',
        })
      )
    })
    expect(h.messageQueueState.acknowledge).not.toHaveBeenCalled()
  })

  it('updates RAG tool availability based on thread/model capabilities', async () => {
    renderComponent()
    await waitFor(() => {
      expect(h.mockUpdateRag).toHaveBeenCalled()
    })
    const args = h.mockUpdateRag.mock.calls[0]
    expect(args[1]).toBe(true) // modelSupportsTools
    expect(args[2]).toBe(true) // ragFeatureAvailable
  })
})
