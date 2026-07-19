/**
 * Default Messages Service - Web implementation
 */

import { ExtensionManager } from '@/lib/extension'
import {
  ConversationalExtension,
  ExtensionTypeEnum,
  ThreadMessage,
} from '@janhq/core'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import type { MessagesService } from './types'

export class DefaultMessagesService implements MessagesService {
  async fetchMessages(threadId: string): Promise<ThreadMessage[]> {
    // Don't fetch messages from server for temporary chat - it's local only
    if (threadId === TEMPORARY_CHAT_ID) {
      return []
    }

    const extension = ExtensionManager.getInstance()
      .get<ConversationalExtension>(ExtensionTypeEnum.Conversational)
    let messages: ThreadMessage[] | undefined
    if (extension) {
      try {
        messages = await extension.listMessages(threadId)
      } catch (error) {
        console.warn('Conversational extension could not list messages; reading durable core storage directly.', error)
      }
    }
    if (!Array.isArray(messages)) {
      const listMessages = window.core?.api?.listMessages
      if (typeof listMessages !== 'function') throw new Error('Durable message storage is unavailable')
      messages = await listMessages({ threadId })
    }
    if (!Array.isArray(messages)) throw new Error('Durable message storage returned an invalid response')
    return messages
  }

  async createMessage(message: ThreadMessage): Promise<ThreadMessage> {
    // Don't create messages on server for temporary chat - it's local only
    if (message.thread_id === TEMPORARY_CHAT_ID) {
      return message
    }

    const extension = ExtensionManager.getInstance()
      .get<ConversationalExtension>(ExtensionTypeEnum.Conversational)
    const persisted = extension
      ? await extension.createMessage(message)
      : await window.core?.api?.createMessage?.({ message })
    if (!persisted || typeof persisted !== 'object') {
      throw new Error('Message was not saved to durable storage')
    }
    return persisted as ThreadMessage
  }

  async modifyMessage(message: ThreadMessage): Promise<ThreadMessage> {
    // Don't modify messages on server for temporary chat - it's local only
    if (message.thread_id === TEMPORARY_CHAT_ID) {
      return message
    }

    const extension = ExtensionManager.getInstance()
      .get<ConversationalExtension>(ExtensionTypeEnum.Conversational)
    const persisted = extension
      ? await extension.modifyMessage(message)
      : await window.core?.api?.modifyMessage?.({ message })
    if (!persisted || typeof persisted !== 'object') {
      throw new Error('Message update was not saved to durable storage')
    }
    return persisted as ThreadMessage
  }

  async deleteMessage(threadId: string, messageId: string): Promise<void> {
    // Don't delete messages on server for temporary chat - it's local only
    if (threadId === TEMPORARY_CHAT_ID) {
      return
    }

    const extension = ExtensionManager.getInstance()
      .get<ConversationalExtension>(ExtensionTypeEnum.Conversational)
    if (extension) {
      await extension.deleteMessage(threadId, messageId)
      return
    }
    const deleteMessage = window.core?.api?.deleteMessage
    if (typeof deleteMessage !== 'function') throw new Error('Durable message storage is unavailable')
    await deleteMessage({ threadId, messageId })
  }
}
