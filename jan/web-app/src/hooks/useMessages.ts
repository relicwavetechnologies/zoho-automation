import { create } from 'zustand'
import { ThreadMessage } from '@janhq/core'
import { getServiceHub } from '@/hooks/useServiceHub'

// A streamed assistant checkpoint is updated many times before its terminal
// write. Keep writes for one message ordered so a delayed older checkpoint can
// never overwrite the completed response that follows it.
const messagePersistence = new Map<string, Promise<unknown>>()

function persistenceKey(threadId: string, messageId: string): string {
  return `${threadId}:${messageId}`
}

function enqueuePersistence<T>(
  key: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = messagePersistence.get(key)
  // Calling the operation synchronously preserves the optimistic store's
  // existing behavior, while Promise.resolve also tolerates legacy adapters
  // that return void at runtime.
  const start = () => Promise.resolve(operation())
  const next = previous
    ? previous.catch(() => undefined).then(start)
    : start()

  messagePersistence.set(key, next)
  void next.then(
    () => {
      if (messagePersistence.get(key) === next) {
        messagePersistence.delete(key)
      }
    },
    () => {
      if (messagePersistence.get(key) === next) {
        messagePersistence.delete(key)
      }
    }
  )
  return next
}

type MessageState = {
  messages: Record<string, ThreadMessage[]>
  getMessages: (threadId: string) => ThreadMessage[]
  setMessages: (threadId: string, messages: ThreadMessage[]) => void
  addMessage: (message: ThreadMessage) => void
  updateMessage: (message: ThreadMessage) => void
  deleteMessage: (threadId: string, messageId: string) => void
  clearAllMessages: () => void
}

export const useMessages = create<MessageState>()((set, get) => ({
  messages: {},
  getMessages: (threadId) => {
    return get().messages[threadId] || []
  },
  setMessages: (threadId, messages) => {
    set((state) => ({
      messages: {
        ...state.messages,
        [threadId]: messages,
      },
    }))
  },
  addMessage: (message) => {
    const newMessage = {
      ...message,
      created_at: message.created_at || Date.now(),
    }

    // Optimistically update state immediately for instant UI feedback
    set((state) => ({
      messages: {
        ...state.messages,
        [message.thread_id]: [
          ...(state.messages[message.thread_id] || []),
          newMessage,
        ],
      },
    }))

    // Persist to storage asynchronously. Later checkpoints for this same
    // message are queued behind the create so they cannot race it.
    void enqueuePersistence(
      persistenceKey(message.thread_id, newMessage.id),
      () => getServiceHub().messages().createMessage(newMessage)
    ).then((createdMessage) => {
      set((state) => ({
        messages: {
          ...state.messages,
          [message.thread_id]:
            state.messages[message.thread_id]?.map((existing) =>
              // Keep any optimistic checkpoint that arrived while create was
              // in flight. Storage returns the original row, not its newer
              // in-memory replacement.
              existing.id === newMessage.id
                ? { ...createdMessage, ...existing }
                : existing
            ) ?? [createdMessage],
        },
      }))
    }).catch((error) => {
      console.error('Failed to persist message:', error)
    })
  },
  updateMessage: (message) => {
    const updatedMessage = {
      ...message,
    }

    // Optimistically update state immediately for instant UI feedback
    set((state) => ({
      messages: {
        ...state.messages,
        [message.thread_id]: (state.messages[message.thread_id] || []).map((m) =>
          m.id === message.id ? updatedMessage : m
        ),
      },
    }))

    // Persist to storage asynchronously using modifyMessage instead of
    // createMessage. Serializing writes per message prevents an earlier
    // streaming snapshot from arriving after a newer final response.
    void enqueuePersistence(
      persistenceKey(message.thread_id, message.id),
      () => getServiceHub().messages().modifyMessage(updatedMessage)
    ).catch((error) => {
      console.error('Failed to persist message update:', error)
    })
  },
  deleteMessage: (threadId, messageId) => {
    void enqueuePersistence(
      persistenceKey(threadId, messageId),
      () => getServiceHub().messages().deleteMessage(threadId, messageId)
    ).catch((error) => {
      console.error('Failed to delete message:', error)
    })
    set((state) => ({
      messages: {
        ...state.messages,
        [threadId]:
          state.messages[threadId]?.filter(
            (message) => message.id !== messageId
          ) || [],
      },
    }))
  },
  clearAllMessages: () => {
    set({ messages: {} })
  },
}))
