import {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  useEffect,
  type ReactNode,
} from 'react'
import type { Thread, Message, ActivityStep } from '../types'
import { useAuth } from './AuthContext'

interface ChatState {
  threads: Thread[]
  activeThread: Thread | null
  messages: Message[]
  isStreaming: boolean
  isThinking: boolean
  streamingText: string
  activitySteps: ActivityStep[]
  error: string | null
  loadThreads: () => Promise<void>
  selectThread: (threadId: string) => Promise<void>
  createThread: () => Promise<string | null>
  deleteThread: (threadId: string) => Promise<void>
  sendMessage: (text: string) => Promise<void>
  clearError: () => void
}

const ChatContext = createContext<ChatState | null>(null)

function buildToolCallsFromSteps(steps: ActivityStep[]): NonNullable<Message['metadata']>['toolCalls'] {
  return steps.map((s) => ({
    id: s.id,
    name: s.name,
    label: s.label,
    icon: s.icon,
    status: s.status === 'done' ? 'completed' : s.status === 'error' ? 'failed' : 'running',
    result: s.resultSummary,
  }))
}

export function ChatProvider({ children }: { children: ReactNode }): JSX.Element {
  const { token } = useAuth()
  const [threads, setThreads] = useState<Thread[]>([])
  const [activeThread, setActiveThread] = useState<Thread | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [isThinking, setIsThinking] = useState(false)
  const [streamingText, setStreamingText] = useState('')
  const [activitySteps, setActivitySteps] = useState<ActivityStep[]>([])
  const [error, setError] = useState<string | null>(null)

  const activeRequestIdRef = useRef<string | null>(null)
  const activeThreadRef = useRef<Thread | null>(null)
  const streamingTextRef = useRef('')
  const activityStepsRef = useRef<ActivityStep[]>([])
  const loadThreadsRef = useRef<(() => Promise<void>) | null>(null)

  useEffect(() => {
    const unsubscribe = window.desktopAPI.chat.onStreamEvent(({ requestId, event }) => {
      if (activeRequestIdRef.current !== requestId) return

      switch (event.type) {
        case 'thinking': {
          // AI started thinking — show shimmer, clear any previous steps
          setIsThinking(true)
          setActivitySteps([])
          activityStepsRef.current = []
          break
        }
        case 'text': {
          // First text token — stop showing "thinking" shimmer
          setIsThinking(false)
          const delta = String(event.data ?? '')
          setStreamingText((prev) => prev + delta)
          break
        }
        case 'activity': {
          // A tool just started — add it to the live activity feed
          const raw = event.data as { id: string; name: string; label: string; icon: string }
          const step: ActivityStep = {
            id: raw.id ?? String(Date.now()),
            name: raw.name ?? '',
            label: raw.label ?? raw.name ?? 'Working...',
            icon: raw.icon ?? 'zap',
            status: 'running',
          }
          setIsThinking(false)
          setActivitySteps((prev) => {
            const next = [...prev, step]
            activityStepsRef.current = next
            return next
          })
          break
        }
        case 'activity_done': {
          // A tool finished — mark it done and keep the final server label/icon if provided
          const raw = event.data as {
            id: string
            label?: string
            icon?: string
            name?: string
            resultSummary?: string
          }
          setActivitySteps((prev) => {
            const next = prev.map((s) =>
              s.id === raw.id
                ? {
                  ...s,
                  name: raw.name ?? s.name,
                  label: raw.label ?? s.label,
                  icon: raw.icon ?? s.icon,
                  status: 'done' as const,
                  resultSummary: raw.resultSummary,
                }
                : s,
            )
            activityStepsRef.current = next
            return next
          })
          break
        }
        case 'error': {
          setError(String(event.data ?? 'Stream failed. Please try again.'))
          setIsStreaming(false)
          setIsThinking(false)
          setActivitySteps([])
          activityStepsRef.current = []
          activeRequestIdRef.current = null
          break
        }
        case 'done': {
          const raw = event.data as { message?: Message } | null
          const persistedMessage = raw?.message

          // Finalize — prefer the persisted backend message so tool-call metadata survives reloads
          setMessages((prev) => {
            if (persistedMessage) {
              return [...prev, persistedMessage]
            }

            const assistantText = streamingTextRef.current.trim()
            if (!assistantText) return prev
            const steps = activityStepsRef.current
            return [
              ...prev,
              {
                id: `assistant-${Date.now()}`,
                threadId: activeThreadRef.current?.id ?? '',
                role: 'assistant',
                content: assistantText,
                createdAt: new Date().toISOString(),
                metadata:
                  steps.length > 0
                    ? {
                      toolCalls: buildToolCallsFromSteps(steps),
                    }
                    : undefined,
              },
            ]
          })
          setStreamingText('')
          setIsStreaming(false)
          setIsThinking(false)
          setActivitySteps([])
          activityStepsRef.current = []
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
  useEffect(() => { streamingTextRef.current = streamingText }, [streamingText])

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
    setStreamingText('')
    setActivitySteps([])
    activityStepsRef.current = []
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
        setIsThinking(false)
        activeRequestIdRef.current = null
        return
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setError('Stream failed. Please try again.')
      }
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
      // If the deleted thread was active, clear the view
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
        streamingText,
        activitySteps,
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
