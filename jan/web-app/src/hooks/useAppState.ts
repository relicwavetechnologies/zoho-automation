import { create } from 'zustand'
import { ThreadMessage } from '@janhq/core'
import { MCPTool } from '@/types/completion'

export type PromptProgress = {
  cache: number
  processed: number
  time_ms: number
  total: number
}

/**
 * Pi lifecycle state used by thread-level consumers such as the sidebar.
 * Capacity waiting is intentionally separate from a thread's follow-up
 * message queue: the user message has already been accepted by Pi.
 */
export type PiThreadRunState = {
  runId: string
  state: 'capacity_waiting' | 'active'
}

type AppErrorMessage = {
  message?: string
  title?: string
  subtitle: string
}

export type AppState = {
  streamingContent?: ThreadMessage
  loadingModel?: boolean
  tools: MCPTool[]
  ragToolNames: Set<string>
  mcpToolNames: Set<string>
  serverStatus: 'running' | 'stopped' | 'pending'
  abortControllers: Record<string, AbortController>
  showOutOfContextDialog?: boolean
  errorMessage?: AppErrorMessage
  promptProgress?: PromptProgress
  activeModels: string[]
  cancelToolCall?: () => void

  streamingContents: Record<string, ThreadMessage>
  loadingModels: Record<string, boolean>
  promptProgresses: Record<string, PromptProgress>
  cancelToolCalls: Record<string, () => void>
  errorMessages: Record<string, AppErrorMessage>
  busyThreads: Record<string, boolean>
  piThreadRunStates: Record<string, PiThreadRunState>
  embeddingThreads: Record<string, boolean>
  currentStreamThreadId?: string
  oomError?: string
  backendError?: string

  setOomError: (line: string | undefined) => void
  setBackendError: (line: string | undefined) => void

  setServerStatus: (value: 'running' | 'stopped' | 'pending') => void
  updateStreamingContent: (content: ThreadMessage | undefined) => void
  updateLoadingModel: (loading: boolean) => void
  updateTools: (tools: MCPTool[]) => void
  updateRagToolNames: (names: string[]) => void
  updateMcpToolNames: (names: string[]) => void
  setAbortController: (threadId: string, controller: AbortController) => void
  clearAppState: () => void
  setOutOfContextDialog: (show: boolean) => void
  setCancelToolCall: (cancel: (() => void) | undefined) => void
  setErrorMessage: (error: AppErrorMessage | undefined) => void
  updatePromptProgress: (progress: PromptProgress | undefined) => void
  setActiveModels: (models: string[]) => void

  updateThreadStreamingContent: (
    threadId: string,
    content: ThreadMessage | undefined
  ) => void
  updateThreadLoadingModel: (threadId: string, loading: boolean) => void
  updateThreadPromptProgress: (
    threadId: string,
    progress: PromptProgress | undefined
  ) => void
  setThreadCancelToolCall: (
    threadId: string,
    cancel: (() => void) | undefined
  ) => void
  setThreadErrorMessage: (
    threadId: string,
    error: AppErrorMessage | undefined
  ) => void
  clearThreadState: (threadId: string) => void
  setCurrentStreamThreadId: (threadId: string | undefined) => void
  setThreadBusy: (threadId: string, busy: boolean) => void
  setPiThreadRunState: (
    threadId: string,
    runId: string,
    state: PiThreadRunState['state']
  ) => void
  clearPiThreadRunState: (threadId: string, runId: string) => void
  setThreadEmbedding: (threadId: string, embedding: boolean) => void
}

export const useAppState = create<AppState>()((set) => ({
  streamingContent: undefined,
  loadingModel: false,
  tools: [],
  ragToolNames: new Set<string>(),
  mcpToolNames: new Set<string>(),
  serverStatus: 'stopped',
  abortControllers: {},
  promptProgress: undefined,
  cancelToolCall: undefined,
  activeModels: [],
  streamingContents: {},
  loadingModels: {},
  promptProgresses: {},
  cancelToolCalls: {},
  errorMessages: {},
  busyThreads: {},
  piThreadRunStates: {},
  embeddingThreads: {},
  currentStreamThreadId: undefined,
  setCurrentStreamThreadId: (threadId) => set({ currentStreamThreadId: threadId }),
  setOomError: (line) => set({ oomError: line }),
  setBackendError: (line) => set({ backendError: line }),
  setThreadBusy: (threadId, busy) =>
    set((state) => {
      const next = { ...state.busyThreads }
      if (busy) next[threadId] = true
      else delete next[threadId]
      return { busyThreads: next }
    }),
  setPiThreadRunState: (threadId, runId, runState) =>
    set((state) => {
      const current = state.piThreadRunStates[threadId]
      // A delayed capacity notification belongs to an older stream. It cannot
      // put a thread back into waiting after a newer run was admitted.
      if (
        runState === 'capacity_waiting' &&
        current?.state === 'active' &&
        current.runId !== runId
      ) {
        return state
      }
      return {
        piThreadRunStates: {
          ...state.piThreadRunStates,
          [threadId]: { runId, state: runState },
        },
      }
    }),
  clearPiThreadRunState: (threadId, runId) =>
    set((state) => {
      const current = state.piThreadRunStates[threadId]
      // A stale terminal event must never clear a newer run for this thread.
      if (!current || current.runId !== runId) return state
      const piThreadRunStates = { ...state.piThreadRunStates }
      delete piThreadRunStates[threadId]
      return { piThreadRunStates }
    }),
  setThreadEmbedding: (threadId, embedding) =>
    set((state) => {
      const next = { ...state.embeddingThreads }
      if (embedding) next[threadId] = true
      else delete next[threadId]
      return { embeddingThreads: next }
    }),
  updateStreamingContent: (content: ThreadMessage | undefined) => {
    set(() => ({
      streamingContent: content
        ? {
            ...content,
            created_at: content.created_at || Date.now(),
          }
        : undefined,
    }))
  },
  updateLoadingModel: (loading) => {
    set({ loadingModel: loading })
  },
  updateTools: (tools) => {
    set({ tools })
  },
  updateRagToolNames: (names) => {
    set({ ragToolNames: new Set(names) })
  },
  updateMcpToolNames: (names) => {
    set({ mcpToolNames: new Set(names) })
  },
  setServerStatus: (value) => set({ serverStatus: value }),
  setAbortController: (threadId, controller) => {
    set((state) => ({
      abortControllers: {
        ...state.abortControllers,
        [threadId]: controller,
      },
    }))
  },
  clearAppState: () =>
    set({
      streamingContent: undefined,
      abortControllers: {},
      piThreadRunStates: {},
      cancelToolCall: undefined,
      errorMessage: undefined,
      showOutOfContextDialog: false,
    }),
  setOutOfContextDialog: (show) => {
    set(() => ({
      showOutOfContextDialog: show,
    }))
  },
  setCancelToolCall: (cancel) => {
    set(() => ({
      cancelToolCall: cancel,
    }))
  },
  setErrorMessage: (error) => {
    set(() => ({
      errorMessage: error,
    }))
  },
  updatePromptProgress: (progress) => {
    set(() => ({
      promptProgress: progress,
    }))
  },
  setActiveModels: (models: string[]) => {
    set(() => ({
      activeModels: models,
    }))
  },

  updateThreadStreamingContent: (threadId, content) =>
    set((state) => {
      const next = { ...state.streamingContents }
      if (content) {
        next[threadId] = {
          ...content,
          created_at: content.created_at || Date.now(),
        }
      } else {
        delete next[threadId]
      }
      return { streamingContents: next }
    }),
  updateThreadLoadingModel: (threadId, loading) =>
    set((state) => {
      const next = { ...state.loadingModels }
      if (loading) next[threadId] = true
      else delete next[threadId]
      return { loadingModels: next }
    }),
  updateThreadPromptProgress: (threadId, progress) =>
    set((state) => {
      const next = { ...state.promptProgresses }
      if (progress) next[threadId] = progress
      else delete next[threadId]
      return { promptProgresses: next }
    }),
  setThreadCancelToolCall: (threadId, cancel) =>
    set((state) => {
      const next = { ...state.cancelToolCalls }
      if (cancel) next[threadId] = cancel
      else delete next[threadId]
      return { cancelToolCalls: next }
    }),
  setThreadErrorMessage: (threadId, error) =>
    set((state) => {
      const next = { ...state.errorMessages }
      if (error) next[threadId] = error
      else delete next[threadId]
      return { errorMessages: next }
    }),
  clearThreadState: (threadId) =>
    set((state) => {
      const streamingContents = { ...state.streamingContents }
      const loadingModels = { ...state.loadingModels }
      const promptProgresses = { ...state.promptProgresses }
      const cancelToolCalls = { ...state.cancelToolCalls }
      const errorMessages = { ...state.errorMessages }
      const busyThreads = { ...state.busyThreads }
      const piThreadRunStates = { ...state.piThreadRunStates }
      const embeddingThreads = { ...state.embeddingThreads }
      delete streamingContents[threadId]
      delete loadingModels[threadId]
      delete promptProgresses[threadId]
      delete cancelToolCalls[threadId]
      delete errorMessages[threadId]
      delete busyThreads[threadId]
      delete piThreadRunStates[threadId]
      delete embeddingThreads[threadId]
      return {
        streamingContents,
        loadingModels,
        promptProgresses,
        cancelToolCalls,
        errorMessages,
        busyThreads,
        piThreadRunStates,
        embeddingThreads,
      }
    }),
}))

export const useActiveThreadIds = () =>
  useAppState((state) => {
    const ids = new Set<string>()
    Object.keys(state.streamingContents).forEach((id) => ids.add(id))
    Object.keys(state.loadingModels).forEach((id) => ids.add(id))
    Object.keys(state.cancelToolCalls).forEach((id) => ids.add(id))
    Object.keys(state.busyThreads).forEach((id) => ids.add(id))
    Object.keys(state.piThreadRunStates).forEach((id) => ids.add(id))
    return ids
  })

/** Stable selectors for concurrent-thread UI. */
export const selectPiThreadRunState = (threadId: string) =>
  (state: AppState): PiThreadRunState | undefined =>
    state.piThreadRunStates[threadId]

export const selectPiThreadCapacityWaiting = (threadId: string) =>
  (state: AppState): boolean =>
    state.piThreadRunStates[threadId]?.state === 'capacity_waiting'

export const useIsThreadActive = (threadId: string | undefined) =>
  useAppState((state) =>
    threadId
      ? threadId in state.streamingContents ||
        threadId in state.loadingModels ||
        threadId in state.cancelToolCalls ||
        threadId in state.busyThreads
      : false
  )
