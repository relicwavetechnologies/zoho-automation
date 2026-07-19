import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DefaultMessagesService } from '../messages/default'
import { ExtensionManager } from '@/lib/extension'
import { ExtensionTypeEnum } from '@janhq/core'

// Mock the ExtensionManager
vi.mock('@/lib/extension', () => ({
  ExtensionManager: {
    getInstance: vi.fn(() => ({
      get: vi.fn()
    }))
  }
}))

describe('DefaultMessagesService', () => {
  let messagesService: DefaultMessagesService
  const originalWindowCore = window.core

  const mockCoreApi = {
    listMessages: vi.fn(),
    createMessage: vi.fn(),
    modifyMessage: vi.fn(),
    deleteMessage: vi.fn(),
  }
  
  const mockExtension = {
    listMessages: vi.fn(),
    createMessage: vi.fn(),
    modifyMessage: vi.fn(),
    deleteMessage: vi.fn()
  }

  const mockExtensionManager = {
    get: vi.fn()
  }

  beforeEach(() => {
    messagesService = new DefaultMessagesService()
    vi.clearAllMocks()
    vi.mocked(ExtensionManager.getInstance).mockReturnValue(mockExtensionManager)
    mockExtensionManager.get.mockReturnValue(mockExtension)
    window.core = { api: mockCoreApi } as any
  })

  afterEach(() => {
    window.core = originalWindowCore
  })

  describe('fetchMessages', () => {
    it('should fetch messages successfully', async () => {
      const threadId = 'thread-123'
      const mockMessages = [
        { id: 'msg-1', threadId, content: 'Hello', role: 'user' },
        { id: 'msg-2', threadId, content: 'Hi there!', role: 'assistant' }
      ]
      mockExtension.listMessages.mockResolvedValue(mockMessages)

      const result = await messagesService.fetchMessages(threadId)

      expect(mockExtensionManager.get).toHaveBeenCalledWith(ExtensionTypeEnum.Conversational)
      expect(mockExtension.listMessages).toHaveBeenCalledWith(threadId)
      expect(result).toEqual(mockMessages)
    })

    it('should read messages directly from durable core storage when extension is unavailable', async () => {
      mockExtensionManager.get.mockReturnValue(null)
      const threadId = 'thread-123'
      const stored = [{ id: 'msg-1', thread_id: threadId, content: 'Stored', role: 'user' }]
      mockCoreApi.listMessages.mockResolvedValue(stored)

      const result = await messagesService.fetchMessages(threadId)

      expect(mockExtensionManager.get).toHaveBeenCalledWith(ExtensionTypeEnum.Conversational)
      expect(mockCoreApi.listMessages).toHaveBeenCalledWith({ threadId })
      expect(result).toEqual(stored)
    })

    it('should read directly from durable core storage when extension listing fails', async () => {
      const threadId = 'thread-123'
      const error = new Error('Failed to list messages')
      mockExtension.listMessages.mockRejectedValue(error)
      mockCoreApi.listMessages.mockResolvedValue([])

      const result = await messagesService.fetchMessages(threadId)

      expect(mockExtensionManager.get).toHaveBeenCalledWith(ExtensionTypeEnum.Conversational)
      expect(mockExtension.listMessages).toHaveBeenCalledWith(threadId)
      expect(result).toEqual([])
      expect(mockCoreApi.listMessages).toHaveBeenCalledWith({ threadId })
    })

    it('should fall back when the extension returns an invalid message response', async () => {
      const threadId = 'thread-123'
      mockExtension.listMessages.mockReturnValue(undefined)
      mockCoreApi.listMessages.mockResolvedValue([])

      const result = await messagesService.fetchMessages(threadId)

      expect(result).toEqual([])
      expect(mockCoreApi.listMessages).toHaveBeenCalledWith({ threadId })
    })
  })

  describe('createMessage', () => {
    it('should create message successfully', async () => {
      const message = { id: 'msg-1', threadId: 'thread-123', content: 'Hello', role: 'user' }
      mockExtension.createMessage.mockResolvedValue(message)

      const result = await messagesService.createMessage(message)

      expect(mockExtensionManager.get).toHaveBeenCalledWith(ExtensionTypeEnum.Conversational)
      expect(mockExtension.createMessage).toHaveBeenCalledWith(message)
      expect(result).toEqual(message)
    })

    it('should create a message directly in durable core storage when extension is unavailable', async () => {
      mockExtensionManager.get.mockReturnValue(null)
      const message = { id: 'msg-1', threadId: 'thread-123', content: 'Hello', role: 'user' }
      mockCoreApi.createMessage.mockResolvedValue(message)

      const result = await messagesService.createMessage(message)

      expect(mockExtensionManager.get).toHaveBeenCalledWith(ExtensionTypeEnum.Conversational)
      expect(result).toEqual(message)
      expect(mockCoreApi.createMessage).toHaveBeenCalledWith({ message })
    })

    it('should surface create failures instead of showing an unsaved message', async () => {
      const message = { id: 'msg-1', threadId: 'thread-123', content: 'Hello', role: 'user' }
      const error = new Error('Failed to create message')
      mockExtension.createMessage.mockRejectedValue(error)

      await expect(messagesService.createMessage(message)).rejects.toThrow('Failed to create message')
      expect(mockExtensionManager.get).toHaveBeenCalledWith(ExtensionTypeEnum.Conversational)
      expect(mockExtension.createMessage).toHaveBeenCalledWith(message)
    })

    it('should reject an invalid create response', async () => {
      const message = { id: 'msg-1', threadId: 'thread-123', content: 'Hello', role: 'user' }
      mockExtension.createMessage.mockReturnValue(undefined)

      await expect(messagesService.createMessage(message)).rejects.toThrow(
        'Message was not saved to durable storage'
      )
    })
  })

  describe('deleteMessage', () => {
    it('should delete message successfully', async () => {
      const threadId = 'thread-123'
      const messageId = 'msg-1'
      mockExtension.deleteMessage.mockResolvedValue(undefined)

      const result = await messagesService.deleteMessage(threadId, messageId)

      expect(mockExtensionManager.get).toHaveBeenCalledWith(ExtensionTypeEnum.Conversational)
      expect(mockExtension.deleteMessage).toHaveBeenCalledWith(threadId, messageId)
      expect(result).toBeUndefined()
    })

    it('should delete directly from durable core storage when extension is unavailable', async () => {
      mockExtensionManager.get.mockReturnValue(null)
      const threadId = 'thread-123'
      const messageId = 'msg-1'

      await messagesService.deleteMessage(threadId, messageId)

      expect(mockExtensionManager.get).toHaveBeenCalledWith(ExtensionTypeEnum.Conversational)
      expect(mockCoreApi.deleteMessage).toHaveBeenCalledWith({ threadId, messageId })
    })

    it('should handle deleteMessage error', async () => {
      const threadId = 'thread-123'
      const messageId = 'msg-1'
      const error = new Error('Failed to delete message')
      mockExtension.deleteMessage.mockRejectedValue(error)

      // Since deleteMessage doesn't have error handling, the error will propagate
      await expect(messagesService.deleteMessage(threadId, messageId)).rejects.toThrow('Failed to delete message')
    })
  })
})
