import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatSessions } from '@/stores/chat-session-store'
import { useAppState } from '@/hooks/useAppState'

const sdk = vi.hoisted(() => ({
  createdChats: [] as Array<{ id: string; transport: unknown }>,
}))

vi.mock('@ai-sdk/react', () => {
  class FakeChat {
    status = 'ready'
    messages: unknown[] = []
    id: string
    transport: unknown

    constructor(options: { id: string; transport: unknown }) {
      this.id = options.id
      this.transport = options.transport
      sdk.createdChats.push({ id: options.id, transport: options.transport })
    }

    ['~registerStatusCallback']() {
      return () => undefined
    }

    stop() {}
  }

  return {
    Chat: FakeChat,
    useChat: ({ chat }: { chat?: FakeChat }) => ({
      messages: chat?.messages ?? [],
      status: chat?.status ?? 'ready',
      error: undefined,
      sendMessage: vi.fn(),
      regenerate: vi.fn(),
      setMessages: vi.fn(),
      stop: vi.fn(),
      addToolOutput: vi.fn(),
    }),
  }
})

import { useChat } from '../use-chat'

describe('useChat transport ownership', () => {
  beforeEach(() => {
    useChatSessions.getState().clearSessions()
    useAppState.setState({ ragToolNames: new Set(), mcpToolNames: new Set() })
    sdk.createdChats.length = 0
  })

  it('creates one transport per thread and restores the matching transport on return', () => {
    const { rerender } = renderHook(
      ({ sessionId }) => useChat({ sessionId }),
      { initialProps: { sessionId: 'thread-a' } }
    )

    const transportA = useChatSessions.getState().sessions['thread-a'].transport
    expect(
      (transportA as unknown as { threadId: string }).threadId
    ).toBe('thread-a')

    act(() => rerender({ sessionId: 'thread-b' }))

    const transportB = useChatSessions.getState().sessions['thread-b'].transport
    expect(transportB).not.toBe(transportA)
    expect(
      (transportB as unknown as { threadId: string }).threadId
    ).toBe('thread-b')
    expect(useChatSessions.getState().sessions['thread-a'].transport).toBe(
      transportA
    )

    act(() => rerender({ sessionId: 'thread-a' }))

    expect(useChatSessions.getState().sessions['thread-a'].transport).toBe(
      transportA
    )
    expect(sdk.createdChats).toHaveLength(2)
    expect(sdk.createdChats.map((chat) => chat.id)).toEqual([
      'thread-a',
      'thread-b',
    ])
  })
})
