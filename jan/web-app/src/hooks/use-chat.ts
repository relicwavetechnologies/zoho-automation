import {
  CustomChatTransport,
} from '@/lib/custom-chat-transport'
import {
  Chat,
  type UIMessage,
  type UseChatOptions,
  useChat as useChatSDK,
} from '@ai-sdk/react'
import {
  type ChatInit,
  type LanguageModelUsage,
} from 'ai'
import { useEffect, useMemo, useCallback } from 'react'
import { useChatSessions } from '@/stores/chat-session-store'
import { useAppState } from '@/hooks/useAppState'
import type { PiTeachProfile } from '@/lib/pi-stream'

type CustomChatOptions = Omit<ChatInit<UIMessage>, 'transport'> &
  Pick<UseChatOptions<UIMessage>, 'experimental_throttle' | 'resume'> & {
    sessionId?: string
    sessionTitle?: string
    systemMessage?: string
    onTokenUsage?: (usage: LanguageModelUsage, messageId: string) => void;
    piProfile?: PiTeachProfile
  }

// This is a wrapper around the AI SDK's useChat hook
// It implements model switching and uses the custom chat transport,
// making a nice reusable hook for chat functionality.
export function useChat(
  options?: CustomChatOptions
) {
  const {
    sessionId,
    sessionTitle,
    systemMessage,
    onTokenUsage,
    piProfile,
    ...chatInitOptions
  } = options ?? {}
  const ensureSession = useChatSessions((state) => state.ensureSession)
  const setSessionTitle = useChatSessions((state) => state.setSessionTitle)
  const updateStatus = useChatSessions((state) => state.updateStatus)

  // Get serviceHub and model metadata from app state
  const mcpToolNames = useAppState((state) => state.mcpToolNames)
  const ragToolNames = useAppState((state) => state.ragToolNames)

  // A transport owns mutable, thread-scoped state (tools, generation token,
  // system prompt, and the Pi thread id). TanStack keeps the route component
  // mounted when only `$threadId` changes, so a component-lifetime ref can
  // accidentally carry thread A's transport into thread B. Resolve or create
  // the transport by session id instead; returning to a thread reuses only
  // that thread's stored transport.
  const transport = useMemo(() => {
    const existingSessionTransport = sessionId
      ? useChatSessions.getState().sessions[sessionId]?.transport
      : undefined
    return (
      existingSessionTransport ??
      new CustomChatTransport(systemMessage, sessionId, piProfile)
    )
    // systemMessage is updated below without recreating a live transport.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  useEffect(() => {
    transport.updateSystemMessage(systemMessage)
  }, [systemMessage, transport])

  useEffect(() => {
    transport.updatePiProfile(piProfile)
  }, [piProfile, transport])

  // Update the token usage callback when it changes
  useEffect(() => {
    transport.setOnTokenUsage(onTokenUsage)
  }, [onTokenUsage, transport])

  // Memoize to prevent calling ensureSession (which has side effects) on every render
  const chat = useMemo(() => {
    if (!sessionId) return undefined

    return ensureSession(
      sessionId,
      transport,
      // The AI SDK otherwise generates an unrelated chat id and passes that
      // value to transport.sendMessages(). Keep all three identities aligned:
      // Jan thread id === session-store key === AI SDK chat id.
      () => new Chat({ ...chatInitOptions, id: sessionId, transport }),
      sessionTitle
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, ensureSession, transport])

  useEffect(() => {
    if (sessionId && sessionTitle) {
      setSessionTitle(sessionId, sessionTitle)
    }
  }, [sessionId, sessionTitle, setSessionTitle])

  const chatResult = useChatSDK({
    ...(chat
      ? { chat }
      : { transport, ...chatInitOptions }),
    experimental_throttle: options?.experimental_throttle,
    resume: false,
  })

  useEffect(() => {
    if (sessionId) {
      updateStatus(sessionId, chatResult.status)
    }
  }, [sessionId, chatResult.status, updateStatus])

  // Refresh tools when MCP or RAG tool names change (e.g., when MCP servers start/stop)
  useEffect(() => {
    // Use forceRefreshTools to update the transport's tool cache. Including
    // the transport ensures a newly selected thread receives the current tool
    // inventory even when the global tool-name sets did not change.
    transport.refreshTools()
  }, [mcpToolNames, ragToolNames, transport])

  const setContinueFromContent = useCallback((content: string) => {
    transport.setContinueFromContent(content)
  }, [transport])

  // Expose method to update RAG tools availability
  const updateRagToolsAvailability = useCallback(
    async (
      hasDocuments: boolean,
      modelSupportsTools: boolean,
      ragFeatureAvailable: boolean
    ) => {
      await transport.updateRagToolsAvailability(
        hasDocuments,
        modelSupportsTools,
        ragFeatureAvailable
      )
    },
    [transport]
  )

  return {
    ...chatResult,
    updateRagToolsAvailability,
    setContinueFromContent,
  }
}
