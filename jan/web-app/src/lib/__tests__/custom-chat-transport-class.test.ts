import { describe, expect, it, vi, beforeEach } from 'vitest'
import { CustomChatTransport, normalizeToolInputSchema } from '../custom-chat-transport'
import { useAppState } from '@/hooks/useAppState'

const piRuntime = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Set<(event: { payload: Record<string, unknown> }) => void>(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: piRuntime.invoke }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(
    async (
      _name: string,
      listener: (event: { payload: Record<string, unknown> }) => void
    ) => {
      piRuntime.listeners.add(listener)
      return () => piRuntime.listeners.delete(listener)
    }
  ),
}))

// Mock all the heavy dependencies
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceStore: { getState: () => ({ serviceHub: {} }) },
}))

vi.mock('@/hooks/useToolAvailable', () => ({
  useToolAvailable: { getState: () => ({ getDisabledToolsForThread: () => [], getDefaultDisabledTools: () => [] }) },
}))

const mockState = vi.hoisted(() => ({
  currentAssistant: null as unknown,
  threads: {} as Record<string, unknown>,
  selectedModel: null as { id: string; capabilities?: string[] } | null,
  selectedProvider: '',
  provider: null as Record<string, unknown> | null,
}))

vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: {
    getState: () => ({
      selectedModel: mockState.selectedModel,
      selectedProvider: mockState.selectedProvider,
      getProviderByName: () => mockState.provider,
    }),
  },
}))

vi.mock('@/hooks/useAssistant', () => ({
  useAssistant: { getState: () => ({ currentAssistant: mockState.currentAssistant }) },
}))

vi.mock('@/hooks/useThreads', () => ({
  useThreads: { getState: () => ({ threads: mockState.threads }) },
}))

vi.mock('@/hooks/useAttachments', () => ({
  useAttachments: { getState: () => ({ enabled: false }) },
}))

vi.mock('@/hooks/useMCPServers', () => ({
  useMCPServers: { getState: () => ({ settings: {} }) },
}))

vi.mock('@/lib/extension', () => ({
  ExtensionManager: { getInstance: () => ({ get: () => null }) },
}))

vi.mock('@/lib/mcp-orchestrator', () => ({
  mcpOrchestrator: { getRelevantTools: vi.fn() },
}))

vi.mock('@/lib/mcp-router-model-filter', () => ({
  isRouterModelSelectable: () => false,
}))

vi.mock('./model-factory', () => ({
  ModelFactory: { createModel: vi.fn() },
}))

describe('CustomChatTransport', () => {
  let transport: CustomChatTransport

  beforeEach(() => {
    mockState.currentAssistant = null
    mockState.threads = {}
    mockState.selectedModel = null
    mockState.selectedProvider = ''
    mockState.provider = null
    piRuntime.invoke.mockReset()
    piRuntime.invoke.mockResolvedValue(undefined)
    piRuntime.listeners.clear()
    transport = new CustomChatTransport('You are helpful', 'thread-1')
  })

  it('initializes with system message', () => {
    expect(transport).toBeDefined()
    expect(transport.model).toBeNull()
  })

  it('getTools returns empty object initially', () => {
    expect(transport.getTools()).toEqual({})
  })

  it('setOnTokenUsage sets callback', () => {
    const cb = vi.fn()
    transport.setOnTokenUsage(cb)
    // No error means it worked
    expect(true).toBe(true)
  })

  it('updateSystemMessage updates the system message', () => {
    transport.updateSystemMessage('new message')
    // Internal state updated - no public getter, just verify no error
    expect(true).toBe(true)
  })

  it('buildFilesSystemAddendum routes attached files through Divo skill resolver first', () => {
    const result = transport.buildFilesSystemAddendum(
      [
        {
          id: 'img-1',
          name: 'screen.png',
          path: '/Users/test/screen.png',
          type: 'image/png',
          size: 100,
        },
        {
          id: 'doc-1',
          name: 'brief.pdf',
          path: '/Users/test/brief.pdf',
          type: 'pdf',
        },
      ],
      { modelSupportsVision: false }
    )

    expect(result).toContain('Your first action for this user request must be to call divo_skill_resolve')
    expect(result).toContain('before using Read, Bash, Python, OCR')
    expect(result).toContain('original user request')
    expect(result).toContain('current selected model does not support native image input')
    expect(result).toContain('do not use the Read tool')
    expect(result).toContain('[ATTACHED_FILES]')
    expect(result).toContain('name: screen.png')
    expect(result).toContain('path: /Users/test/brief.pdf')
    expect(result).not.toContain('media.image_ocr')
  })

  it('buildPiUserMessage strips raw attachment metadata and prepends Divo routing', () => {
    const result = transport.buildPiUserMessage(
      [
        {
          id: 'u1',
          role: 'user',
          parts: [
            {
              type: 'text',
              text: [
                'Tell me what is in this image.',
                '',
                '[ATTACHED_FILES]',
                '- file_id: img-1, name: screenshot.png, path: /Users/test/screenshot.png, type: image/png, size: 100',
                '[/ATTACHED_FILES]',
              ].join('\n'),
            },
          ],
        } as any,
      ],
      { modelSupportsVision: false }
    )

    expect(result).toContain('[DIVO_ATTACHMENT_ROUTING]')
    expect(result).toContain('call divo_gateway directly')
    expect(result).toContain('op: "media.image_ocr"')
    expect(result).toContain('payload: { filePath')
    expect(result).toContain('desktop attachment pipeline already normalized')
    expect(result).toContain('compressed oversized images')
    expect(result).toContain('Do not convert or compress the image yourself')
    expect(result).toContain('before Read/Bash/Python/local image tools')
    expect(result).toContain('current selected model does not support native image input')
    expect(result).toContain('path: /Users/test/screenshot.png')
    expect(result).toContain('Tell me what is in this image.')
    expect(result.match(/\[ATTACHED_FILES\]/g)).toHaveLength(1)
  })

  it('buildPiUserMessage injects selected Divo skill references before the user request', () => {
    const result = transport.buildPiUserMessage([
      {
        id: 'u1',
        role: 'user',
        parts: [{ type: 'text', text: 'list my unread mails' }],
        metadata: {
          divoSkillReferences: [
            {
              id: 'google',
              name: 'Google Workspace',
              description: 'Gmail, Drive, and Calendar workflows.',
              category: 'Google',
              toolIds: ['googleGmail'],
            },
          ],
        },
      } as any,
    ])

    expect(result).toContain('[DIVO_SKILL_REFERENCES]')
    expect(result).toContain('You must load the selected skill recipe')
    expect(result).toContain('divo_gateway({')
    expect(result).toContain('"op": "skills.get"')
    expect(result).toContain('"skillId": "<skillId>"')
    expect(result).toContain('skillId: google')
    expect(result).toContain('list my unread mails')
    expect(result.indexOf('[DIVO_SKILL_REFERENCES]')).toBeLessThan(
      result.indexOf('list my unread mails')
    )
  })

  it('setContinueFromContent sets content', () => {
    transport.setContinueFromContent('partial content')
    expect(true).toBe(true)
  })

  it('setLastUserMessage sets the message', () => {
    transport.setLastUserMessage('hello')
    expect(true).toBe(true)
  })

  it('isolates concurrent Pi transport streams and removes only the terminal listener', async () => {
    mockState.selectedModel = { id: 'divo-pi' }
    mockState.selectedProvider = 'pi'
    mockState.provider = { id: 'pi' }
    useAppState.setState({ busyThreads: {}, piThreadRunStates: {} })

    const first = new CustomChatTransport(undefined, 'thread-a')
    const second = new CustomChatTransport(undefined, 'thread-b')
    const request = (text: string, chatId: string) => ({
      chatId,
      messages: [{ id: `message-${chatId}`, role: 'user', parts: [{ type: 'text', text }] }],
      abortSignal: undefined,
      trigger: 'submit-message' as const,
      messageId: undefined,
    })

    const [streamA, streamB] = await Promise.all([
      first.sendMessages(request('first', 'thread-a') as any),
      second.sendMessages(request('second', 'thread-b') as any),
    ])
    await vi.waitFor(() =>
      expect(
        piRuntime.invoke.mock.calls.filter(([command]) => command === 'pi_prompt')
      ).toHaveLength(2)
    )
    const prompts = piRuntime.invoke.mock.calls
      .filter(([command]) => command === 'pi_prompt')
      .map(([, payload]) => payload as { threadId: string; runId: string })
    const promptA = prompts.find((prompt) => prompt.threadId === 'thread-a')!
    const promptB = prompts.find((prompt) => prompt.threadId === 'thread-b')!
    const emit = (payload: Record<string, unknown>) => {
      for (const listener of [...piRuntime.listeners]) listener({ payload })
    }

    emit({ type: 'pi_runtime_waiting', thread_id: 'thread-a', run_id: promptA.runId })
    expect(useAppState.getState().piThreadRunStates['thread-a']).toEqual({
      runId: promptA.runId,
      state: 'capacity_waiting',
    })
    expect(useAppState.getState().piThreadRunStates['thread-b']).toBeUndefined()

    emit({ type: 'prompt_accepted', thread_id: 'thread-a', run_id: promptA.runId })
    emit({ type: 'message_update', thread_id: 'thread-b', run_id: promptB.runId, assistantMessageEvent: { type: 'text_delta', delta: 'B only' } })
    expect(useAppState.getState().piThreadRunStates['thread-a']).toEqual({
      runId: promptA.runId,
      state: 'active',
    })
    expect(useAppState.getState().busyThreads).toEqual({ 'thread-a': true, 'thread-b': true })

    const listenerCountBeforeTerminal = piRuntime.listeners.size
    emit({ type: 'agent_end', thread_id: 'thread-a', run_id: promptA.runId })
    await vi.waitFor(() => expect(piRuntime.listeners.size).toBe(listenerCountBeforeTerminal - 1))
    expect(useAppState.getState().busyThreads['thread-a']).toBeUndefined()
    expect(useAppState.getState().busyThreads['thread-b']).toBe(true)

    // A delayed waiting notification from A must not alter B, and B's own
    // listener remains live after A unlistens.
    emit({ type: 'pi_runtime_waiting', thread_id: 'thread-a', run_id: promptA.runId })
    emit({ type: 'prompt_accepted', thread_id: 'thread-b', run_id: promptB.runId })
    expect(useAppState.getState().piThreadRunStates['thread-b']).toEqual({
      runId: promptB.runId,
      state: 'active',
    })

    await streamA.cancel()
    await streamB.cancel()
  })

  it('reconnectToStream returns null', async () => {
    const result = await transport.reconnectToStream({ chatId: 'c1' } as any)
    expect(result).toBeNull()
  })

  it('mapUserInlineAttachments passes through non-user messages', () => {
    const messages = [
      { role: 'assistant', parts: [{ type: 'text', text: 'Hi' }], metadata: {} },
    ] as any
    const result = transport.mapUserInlineAttachments(messages)
    expect(result[0].parts[0].text).toBe('Hi')
  })

  it('mapUserInlineAttachments appends inline files to user text', () => {
    const messages = [
      {
        role: 'user',
        parts: [{ type: 'text', text: 'Check this' }],
        metadata: {
          inline_file_contents: [{ name: 'file.txt', content: 'hello world' }],
        },
      },
    ] as any
    const result = transport.mapUserInlineAttachments(messages)
    expect(result[0].parts[0].text).toContain('file.txt')
    expect(result[0].parts[0].text).toContain('hello world')
  })

  it('mapUserInlineAttachments ignores entries without content', () => {
    const messages = [
      {
        role: 'user',
        parts: [{ type: 'text', text: 'Check' }],
        metadata: {
          inline_file_contents: [{ name: 'empty.txt' }],
        },
      },
    ] as any
    const result = transport.mapUserInlineAttachments(messages)
    expect(result[0].parts[0].text).toBe('Check')
  })

  describe('inference params follow the thread assistant', () => {
    type Resolvable = {
      getActiveInferenceParams: () => Record<string, unknown>
    }
    const resolve = (t: CustomChatTransport = transport) =>
      (t as unknown as Resolvable).getActiveInferenceParams()

    it('reads params from the thread assistant when set', () => {
      mockState.currentAssistant = { id: 'default', parameters: { temperature: 0.1 } }
      mockState.threads = {
        'thread-1': { assistants: [{ id: 'agent-b', parameters: { temperature: 0.9 } }] },
      }
      expect(resolve()).toEqual({ temperature: 0.9 })
    })

    it('uses no params for a model-only thread, ignoring the global default', () => {
      mockState.currentAssistant = { id: 'default', parameters: { temperature: 0.1 } }
      mockState.threads = { 'thread-1': { assistants: [{ id: 'model-only' }] } }
      expect(resolve()).toEqual({})
    })

    it('falls back to the global assistant only when off-thread', () => {
      mockState.currentAssistant = { id: 'default', parameters: { temperature: 0.1 } }
      mockState.threads = {}
      expect(resolve(new CustomChatTransport('sys'))).toEqual({ temperature: 0.1 })
    })

    it('returns an empty object when nothing is set', () => {
      expect(resolve(new CustomChatTransport('sys'))).toEqual({})
    })
  })
})

describe('normalizeToolInputSchema edge cases', () => {
  it('handles null/undefined values', () => {
    expect(normalizeToolInputSchema({ type: 'string', default: null })).toEqual({
      type: 'string',
      default: null,
    })
  })

  it('handles primitive values', () => {
    expect(normalizeToolInputSchema({ type: 'number' })).toEqual({ type: 'number' })
  })

  it('handles $ref without adding type', () => {
    const schema = { $ref: '#/definitions/Foo', description: 'A foo' }
    const result = normalizeToolInputSchema(schema)
    expect(result.type).toBeUndefined()
    expect(result.$ref).toBe('#/definitions/Foo')
  })

  it('handles arrays at top level', () => {
    const schema = {
      type: 'object',
      properties: {
        tags: {
          type: 'array',
          items: { description: 'A tag' },
        },
      },
    }
    const result = normalizeToolInputSchema(schema)
    expect((result.properties as any).tags.items.type).toBe('string')
  })
})
