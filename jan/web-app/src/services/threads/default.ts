/**
 * Default Threads Service - Web implementation
 */

import { ExtensionManager } from '@/lib/extension'
import { ConversationalExtension, ExtensionTypeEnum } from '@janhq/core'
import type { ThreadsService } from './types'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'

function toModelPayload(model?: Thread['model']) {
  return { id: model?.id ?? '*', engine: model?.provider ?? 'llamacpp' }
}

function fromModelResponse(
  assistantModel: { id: string; engine?: string } | undefined,
  fallback?: Thread['model']
): Thread['model'] | undefined {
  if (assistantModel) {
    return { id: assistantModel.id, provider: assistantModel.engine ?? 'llamacpp' }
  }
  return fallback
}

export class DefaultThreadsService implements ThreadsService {
  async fetchThreads(): Promise<Thread[]> {
    const extension = ExtensionManager.getInstance()
      .get<ConversationalExtension>(ExtensionTypeEnum.Conversational)
    let threads: Thread[] | undefined
    if (extension) {
      try {
        threads = await extension.listThreads()
      } catch (error) {
        console.warn('Conversational extension could not list threads; reading durable core storage directly.', error)
      }
    }
    if (!Array.isArray(threads)) {
      const listThreads = window.core?.api?.listThreads
      if (typeof listThreads !== 'function') {
        throw new Error('Durable thread storage is unavailable')
      }
      threads = await listThreads()
    }
    if (!Array.isArray(threads)) {
      throw new Error('Durable thread storage returned an invalid response')
    }

    // new String("id") !== "id"
    threads.forEach((e) => {
      e.id = e.id?.toString()
      e.assistants?.forEach((a) => {
        a.id = a.id?.toString()
        if (a.model) a.model.id = a.model.id?.toString()
      })
    })

    // Filter out temporary threads from the list
    const filteredThreads = threads.filter(
      (e) => e.id !== TEMPORARY_CHAT_ID
    )

    return filteredThreads.map((e) => {
      const model = fromModelResponse(e.assistants?.[0]?.model)
      const assistants = e.assistants

      return {
        ...e,
        updated:
          typeof e.updated === 'number' && e.updated > 1e12
            ? Math.floor(e.updated / 1000)
            : (e.updated ?? 0),
        order: e.metadata?.order,
        isFavorite: e.metadata?.is_favorite,
        model,
        assistants,
        metadata: {
          ...e.metadata,
          // Override extracted fields to avoid duplication
          order: e.metadata?.order,
          is_favorite: e.metadata?.is_favorite,
        },
      } as Thread
    })
  }

  async createThread(thread: Thread): Promise<Thread> {
    // For temporary threads, bypass the conversational extension (in-memory only)
    if (thread.id === TEMPORARY_CHAT_ID) {
      return thread
    }

    // Build assistants payload - always include model info
    // If there's a real assistant (with instructions), include full assistant data
    // Otherwise, just include minimal model-only entry for storage
    const hasRealAssistant = thread.assistants && thread.assistants.length > 0
    const modelPayload = toModelPayload(thread.model)
    const assistantsPayload = hasRealAssistant
      ? [{ ...thread.assistants![0], model: modelPayload }]
      : [{ id: 'model-only', name: 'Model', model: modelPayload }]

    const extension = ExtensionManager.getInstance()
      .get<ConversationalExtension>(ExtensionTypeEnum.Conversational)
    const persisted = extension
      ? await extension.createThread({
          ...thread,
          assistants: assistantsPayload,
          metadata: {
            ...thread.metadata,
            order: thread.order,
          },
        })
      : await window.core?.api?.createThread?.({
          thread: {
            ...thread,
            assistants: assistantsPayload,
            metadata: { ...thread.metadata, order: thread.order },
          },
        })
    if (!persisted || typeof persisted !== 'object') {
      throw new Error('Thread was not saved to durable storage')
    }
    const e = persisted as Thread
    const model = fromModelResponse(e.assistants?.[0]?.model, thread.model)

    const assistants = e.assistants

    return {
      ...e,
      updated: e.updated,
      model,
      order: e.metadata?.order ?? thread.order,
      assistants,
    } as Thread
  }

  async updateThread(thread: Thread): Promise<void> {
    // For temporary threads, skip updating via conversational extension
    if (thread.id === TEMPORARY_CHAT_ID) {
      return
    }

    const payload = {
        ...thread,
        assistants: thread.assistants?.map((e) => ({
          ...e,
          model: toModelPayload(thread.model),
        })) ?? [
          { model: toModelPayload(thread.model), id: 'jan', name: 'Divo Dex' },
        ],
        metadata: {
          ...thread.metadata,
          is_favorite: thread.isFavorite,
          order: thread.order,
        },
        object: 'thread',
        created: Date.now() / 1000,
        updated: Date.now() / 1000,
      }
    const extension = ExtensionManager.getInstance()
      .get<ConversationalExtension>(ExtensionTypeEnum.Conversational)
    if (extension) {
      await extension.modifyThread(payload)
      return
    }
    const modifyThread = window.core?.api?.modifyThread
    if (typeof modifyThread !== 'function') throw new Error('Durable thread storage is unavailable')
    await modifyThread({ thread: payload })
  }

  async deleteThread(threadId: string): Promise<void> {
    // For temporary threads, skip deleting via conversational extension
    if (threadId === TEMPORARY_CHAT_ID) {
      return
    }

    const extension = ExtensionManager.getInstance()
      .get<ConversationalExtension>(ExtensionTypeEnum.Conversational)
    if (extension) {
      await extension.deleteThread(threadId)
      return
    }
    const deleteThread = window.core?.api?.deleteThread
    if (typeof deleteThread !== 'function') throw new Error('Durable thread storage is unavailable')
    await deleteThread({ threadId })
  }
}
