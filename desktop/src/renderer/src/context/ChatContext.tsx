import {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  useEffect,
  type ReactNode,
} from 'react'
import type { Thread, Message, ContentBlock } from '../types'
import { useAuth } from './AuthContext'

interface ChatState {
  threads: Thread[]
  activeThread: Thread | null
  messages: Message[]
  isStreaming: boolean
  /** True while waiting for the first block (shows thinking shimmer) */
  isThinking: boolean
  /** Ordered live timeline during streaming — replaces activitySteps + streamingText */
  liveBlocks: ContentBlock[]
  error: string | null
  loadThreads: () => Promise<void>
  selectThread: (threadId: string) => Promise<void>
  createThread: () => Promise<string | null>
  deleteThread: (threadId: string) => Promise<void>
  sendMessage: (text: string) => Promise<void>
  clearError: () => void
}

const ChatContext = createContext<ChatState | null>(null)

export function ChatProvider({ children }: { children: ReactNode }): JSX.Element {
  const { token } = useAuth()
  const [threads, setThreads] = useState<Thread[]>([])
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

  // ── SSE Event Handler ──────────────────────────────────────────────────────
  useEffect(() => {
    const unsubscribe = window.desktopAPI.chat.onStreamEvent(({ requestId, event }) => {
      if (activeRequestIdRef.current !== requestId) return

      switch (event.type) {
        case 'thinking': {
          setIsThinking(true)
          setLiveBlocks((prev) => {
            const next: ContentBlock[] = [...prev, { type: 'thinking' }]
            liveBlocksRef.current = next
            return next
          })
          break
        }

        case 'activity': {
          const raw = event.data as { id: string; name: string; label: string; icon: string }
          setIsThinking(false)
          setLiveBlocks((prev) => {
            const next: ContentBlock[] = [
              ...prev,
              {
                type: 'tool',
                id: raw.id ?? String(Date.now()),
                name: raw.name ?? '',
                label: raw.label ?? raw.name ?? 'Working...',
                icon: raw.icon ?? 'zap',
                status: 'running',
              },
            ]
            liveBlocksRef.current = next
            return next
          })
          break
        }

        case 'activity_done': {
          const raw = event.data as {
            id: string; label?: string; icon?: string; name?: string; resultSummary?: string
          }
          setIsThinking(true)
          setLiveBlocks((prev: ContentBlock[]) => {
            const next: ContentBlock[] = [
              ...prev.map((b: ContentBlock) =>
                b.type === 'tool' && b.id === raw.id
                  ? ({
                    ...b,
                    name: raw.name ?? b.name,
                    label: raw.label ?? b.label,
                    icon: raw.icon ?? b.icon,
                    status: 'done' as const,
                    resultSummary: raw.resultSummary,
                  } as ContentBlock)
                  : b,
              ),
              { type: 'thinking' },
            ]
            liveBlocksRef.current = next
            return next
          })
          break
        }

        case 'text': {
          const chunk = String(event.data ?? '')
          setIsThinking(false)
          setLiveBlocks((prev) => {
            const last = prev[prev.length - 1]
            let next: ContentBlock[]
            if (last?.type === 'text') {
              next = [
                ...prev.slice(0, -1),
                { type: 'text', content: last.content + chunk },
              ]
            } else {
              next = [...prev, { type: 'text', content: chunk }]
            }
            liveBlocksRef.current = next
            return next
          })
          break
        }

        case 'error': {
          setError(String(event.data ?? 'Stream failed. Please try again.'))
          setIsStreaming(false)
          setIsThinking(false)
          setLiveBlocks([])
          liveBlocksRef.current = []
          activeRequestIdRef.current = null
          break
        }

        case 'done': {
          const raw = event.data as { message?: Message } | null
          const persistedMessage = raw?.message

          setMessages((prev) => {
            if (persistedMessage) {
              // Server sent the DB-persisted message — use it directly (has contentBlocks)
              return [...prev, persistedMessage]
            }
            // Fallback: build from live blocks
            const blocks = liveBlocksRef.current
            const textContent = blocks
              .filter((b): b is { type: 'text'; content: string } => b.type === 'text')
              .map((b) => b.content)
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
  }, [])

  useEffect(() => { activeThreadRef.current = activeThread }, [activeThread])

  const loadThreads = useCallback(async () => {
    if (!token) return
    try {
      const res = await window.desktopAPI.threads.list(token)
      if (res.success && res.data) setThreads(res.data as Thread[])
    } catch {
      setError('Failed to load threads')
    }
  }, [token])

  useEffect(() => { loadThreadsRef.current = loadThreads }, [loadThreads])

  const selectThread = useCallback(async (threadId: string) => {
    if (!token) return
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
  }, [token])

  const createThread = useCallback(async (): Promise<string | null> => {
    if (!token) return null
    try {
      const res = await window.desktopAPI.threads.create(token)
      if (res.success && res.data) {
        const newThread = res.data as Thread
        setThreads((prev) => [newThread, ...prev])
        setActiveThread(newThread)
        setMessages([])
        return newThread.id
      }
      return null
    } catch {
      setError('Failed to create thread')
      return null
    }
  }, [token])

  const sendMessage = useCallback(async (text: string) => {
    if (!token || !activeThread || isStreaming) return

    const userMsg: Message = {
      id: `temp-${Date.now()}`,
      threadId: activeThread.id,
      role: 'user',
      content: text,
      createdAt: new Date().toISOString(),
    }
    setMessages((prev) => [...prev, userMsg])
    setIsStreaming(true)
    setIsThinking(false)
    setLiveBlocks([])
    liveBlocksRef.current = []
    setError(null)

    try {
      const requestId = crypto.randomUUID()
      activeRequestIdRef.current = requestId
      const sendRes = await window.desktopAPI.chat.startStream(token, activeThread.id, text, requestId)
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
  }, [token, activeThread, isStreaming])

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
      setThreads((prev) => prev.filter((t) => t.id !== threadId))
      if (activeThreadRef.current?.id === threadId) {
        setActiveThread(null)
        setMessages([])
      }
    } catch (err) {
      console.error('delete thread IPC error:', err)
      setError('Failed to delete thread — please restart the app and try again')
    }
  }, [token])

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
