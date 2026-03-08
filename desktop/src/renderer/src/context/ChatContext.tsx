import {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  useEffect,
  type ReactNode,
} from 'react'
import type { Thread, Message } from '../types'
import { useAuth } from './AuthContext'

interface ChatState {
  threads: Thread[]
  activeThread: Thread | null
  messages: Message[]
  isStreaming: boolean
  streamingText: string
  error: string | null
  loadThreads: () => Promise<void>
  selectThread: (threadId: string) => Promise<void>
  createThread: () => Promise<string | null>
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
  const [streamingText, setStreamingText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const activeRequestIdRef = useRef<string | null>(null)
  const activeThreadRef = useRef<Thread | null>(null)
  const streamingTextRef = useRef('')
  const loadThreadsRef = useRef<(() => Promise<void>) | null>(null)

  useEffect(() => {
    const unsubscribe = window.desktopAPI.chat.onStreamEvent(({ requestId, event }) => {
      if (activeRequestIdRef.current !== requestId) return

      switch (event.type) {
        case 'text': {
          const delta = String(event.data ?? '')
          setStreamingText((prev) => prev + delta)
          break
        }
        case 'error': {
          setError(String(event.data ?? 'Stream failed. Please try again.'))
          setIsStreaming(false)
          activeRequestIdRef.current = null
          break
        }
        case 'done': {
          setMessages((prev) => {
            const assistantText = streamingTextRef.current.trim()
            if (!assistantText) return prev
            return [
              ...prev,
              {
                id: `assistant-${Date.now()}`,
                threadId: activeThreadRef.current?.id ?? '',
                role: 'assistant',
                content: assistantText,
                createdAt: new Date().toISOString(),
              },
            ]
          })
          setStreamingText('')
          setIsStreaming(false)
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

  useEffect(() => {
    activeThreadRef.current = activeThread
  }, [activeThread])

  useEffect(() => {
    streamingTextRef.current = streamingText
  }, [streamingText])

  const loadThreads = useCallback(async () => {
    if (!token) return
    try {
      const res = await window.desktopAPI.threads.list(token)
      if (res.success && res.data) {
        setThreads(res.data as Thread[])
      }
    } catch {
      setError('Failed to load threads')
    }
  }, [token])

  useEffect(() => {
    loadThreadsRef.current = loadThreads
  }, [loadThreads])

  const selectThread = useCallback(
    async (threadId: string) => {
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
    },
    [token],
  )

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

  const sendMessage = useCallback(
    async (text: string) => {
      if (!token || !activeThread || isStreaming) return

      // Add user message optimistically
      const userMsg: Message = {
        id: `temp-${Date.now()}`,
        threadId: activeThread.id,
        role: 'user',
        content: text,
        createdAt: new Date().toISOString(),
      }
      setMessages((prev) => [...prev, userMsg])
      setIsStreaming(true)
      setStreamingText('')
      setError(null)

      try {
        const requestId = crypto.randomUUID()
        activeRequestIdRef.current = requestId
        const sendRes = await window.desktopAPI.chat.startStream(
          token,
          activeThread.id,
          text,
          requestId,
        )
        if (!sendRes.success) {
          setError('Failed to send message')
          setIsStreaming(false)
          activeRequestIdRef.current = null
          return
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setError('Stream failed. Please try again.')
        }
        setIsStreaming(false)
        activeRequestIdRef.current = null
      }
    },
    [token, activeThread, isStreaming],
  )

  const clearError = useCallback(() => setError(null), [])

  return (
    <ChatContext.Provider
      value={{
        threads,
        activeThread,
        messages,
        isStreaming,
        streamingText,
        error,
        loadThreads,
        selectThread,
        createThread,
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
