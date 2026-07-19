import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createFileRoute, useParams, useSearch } from '@tanstack/react-router'
import { cn } from '@/lib/utils'

import HeaderPage from '@/containers/HeaderPage'
import { useThreads } from '@/hooks/useThreads'
import ChatInput from '@/containers/ChatInput'
import { useShallow } from 'zustand/react/shallow'
import { MessageItem } from '@/containers/MessageItem'

import { useMessages } from '@/hooks/useMessages'
import { useMessageErrors } from '@/stores/message-errors'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTools } from '@/hooks/useTools'
import { useAppState } from '@/hooks/useAppState'
import { SESSION_STORAGE_PREFIX } from '@/constants/chat'
import { useChat } from '@/hooks/use-chat'
import { useModelProvider } from '@/hooks/useModelProvider'
import { renderInstructions } from '@/lib/instructionTemplate'
import {
  Conversation,
  ConversationContent,
  ConversationPinSpacer,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation'
import { invoke } from '@tauri-apps/api/core'
import { generateId, lastAssistantMessageIsCompleteWithToolCalls } from 'ai'
import type { UIMessage } from '@ai-sdk/react'
import { useChatSessions } from '@/stores/chat-session-store'
import {
  convertThreadMessagesToUIMessages,
  extractContentPartsFromUIMessage,
  uiMessageHasMeaningfulContent,
  threadMessageIsEmpty,
} from '@/lib/messages'
import { newUserThreadContent } from '@/lib/completion'
import {
  computeActivePath,
  backfillParentIds,
  makeSibling,
  withActiveChild,
  getParentId,
  getSiblings,
  getVersionInfo,
  hasBranching,
  repairDetachedAssistants,
} from '@/lib/message-branching'
import {
  ThreadMessage,
  MessageStatus,
  ChatCompletionRole,
} from '@janhq/core'
import {
  createImageAttachment,
  createAudioAttachment,
  createVideoAttachment,
  type Attachment,
} from '@/types/attachment'
import {
  useChatAttachments,
  NEW_THREAD_ATTACHMENT_KEY,
} from '@/hooks/useChatAttachments'
import { processAttachmentsForSend } from '@/lib/attachmentProcessing'
import { useAttachments } from '@/hooks/useAttachments'
import { PromptProgress } from '@/components/PromptProgress'
import { useToolAvailable } from '@/hooks/useToolAvailable'
import {
  OUT_OF_CONTEXT_SIZE,
  isContextOverflowMessage,
  parseContextOverflow,
} from '@/utils/error'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Button } from '@/components/ui/button'
import { IconAlertCircle, IconRefresh, IconLoader2 } from '@tabler/icons-react'
import { useToolApproval } from '@/hooks/useToolApproval'
import DivoWorkspaceSelector from '@/containers/DivoWorkspaceSelector'
import { ExtensionTypeEnum, VectorDBExtension } from '@janhq/core'
import { ExtensionManager } from '@/lib/extension'
import { Shimmer } from '@/components/ai-elements/shimmer'
import {
  useMessageQueue,
  type QueuedMessage,
} from '@/stores/message-queue-store'
import { generateThreadTitle } from '@/lib/thread-title-summarizer'
import { useAutoScroll } from '@/hooks/useAutoScroll'
import {
  DIVO_SKILL_REFERENCES_METADATA_KEY,
  normalizeDivoSkillReferences,
  type DivoSkillReference,
  type DivoSkillReferenceSubmitOptions,
} from '@/lib/divo-skill-reference-context'
import { DIVO_QUICK_START_METADATA_KEY } from '@/lib/divo-finance-quick-start'
import {
  clearDivoTeachPendingMessage,
  readDivoTeachPendingMessage,
  readDivoTeachProfile,
  teachThreadDisplayTitle,
} from '@/lib/divo-teach-thread'
import {
  isPiStreamCheckpoint,
  isPiTraceMessage,
  recoverPiStreamCheckpoint,
  withPiStreamCheckpoint,
} from '@/lib/pi'

const CHAT_STATUS = {
  STREAMING: 'streaming',
  SUBMITTED: 'submitted',
} as const

const TITLE_REFRESH_EVERY_N_ASSISTANT_MESSAGES = 4

class QueuedBranchParentMissingError extends Error {
  constructor() {
    super(
      'The original branch for this queued message no longer exists. Edit or remove the queued message before retrying.'
    )
    this.name = 'QueuedBranchParentMissingError'
  }
}

class QueuedSendCancelledError extends Error {
  constructor() {
    super('Queued message was cancelled before submission')
    this.name = 'QueuedSendCancelledError'
  }
}

class QueuedSubmissionNotAcceptedError extends Error {
  constructor() {
    super('Queued message was not accepted by the provider')
    this.name = 'QueuedSubmissionNotAcceptedError'
  }
}

function findBranchRootId(
  messages: ThreadMessage[],
  nodeId: string
): string | undefined {
  const byId = new Map(messages.map((message) => [message.id, message]))
  let current = byId.get(nodeId)
  const seen = new Set<string>()
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    const parentId = getParentId(current)
    if (!parentId) return current.id
    current = byId.get(parentId)
  }
  return undefined
}

// Persist the out-of-context error onto the latest user message so the banner
// survives thread switches, mirroring how LlamacppOomListener stamps oom/backend.
function stampContextErrorOnThread(
  threadId: string,
  message: string = OUT_OF_CONTEXT_SIZE
) {
  const messages = useMessages.getState().getMessages(threadId)
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'user') continue
    const meta = (m.metadata as Record<string, unknown> | undefined) ?? {}
    if (typeof meta.contextError === 'string') return
    useMessages.getState().updateMessage({
      ...m,
      metadata: { ...meta, contextError: message },
    })
    return
  }
}

type ThreadModel = {
  id: string
  provider: string
}

type SearchParams = {
  threadModel?: ThreadModel
}

// as route.threadsDetail
export const Route = createFileRoute('/threads/$threadId')({
  component: ThreadDetail,
  // ThreadDetail owns several refs and callbacks tied to one chat lifecycle.
  // Remounting on param changes is a second boundary behind the transport's
  // own ownership check, preventing route-local state from leaking A -> B.
  remountDeps: ({ params }) => params.threadId,
  validateSearch: (search: Record<string, unknown>): SearchParams => {
    return {
      threadModel: search.threadModel as ThreadModel | undefined,
    }
  },
})

function ThreadDetail() {
  const serviceHub = useServiceHub()
  const { threadId } = useParams({ from: Route.id })
  const search = useSearch({ from: Route.id })
  const searchThreadModel = search.threadModel
  const setCurrentThreadId = useThreads((state) => state.setCurrentThreadId)
  const setMessages = useMessages((state) => state.setMessages)
  const addMessage = useMessages((state) => state.addMessage)
  const updateMessage = useMessages((state) => state.updateMessage)
  const deleteMessage = useMessages((state) => state.deleteMessage)
  const currentThread = useRef<string | undefined>(undefined)

  useTools()

  // Get attachments for this thread
  const attachmentsKey = threadId ?? NEW_THREAD_ATTACHMENT_KEY
  const getAttachments = useChatAttachments((state) => state.getAttachments)
  const clearAttachmentsForThread = useChatAttachments(
    (state) => state.clearAttachments
  )
  const queuedMessages = useMessageQueue(
    useShallow((state) => state.getQueue(threadId))
  )

  // Session data for tool call tracking
  const getSessionData = useChatSessions((state) => state.getSessionData)
  const sessionData = getSessionData(threadId)

  // AbortController for cancelling tool calls
  const toolCallAbortController = useRef<AbortController | null>(null)

  const titleAbortRef = useRef<AbortController | null>(null)

  // Check if we should follow up with tool calls (respects abort signal)
  const followUpMessage = useCallback(
    ({ messages }: { messages: UIMessage[] }) => {
      if (
        !toolCallAbortController.current ||
        toolCallAbortController.current?.signal.aborted
      ) {
        return false
      }
      return lastAssistantMessageIsCompleteWithToolCalls({ messages })
    },
    []
  )

  // Subscribe directly to the thread data to ensure updates when model changes
  const thread = useThreads(useShallow((state) => state.threads[threadId]))

  // Get model and provider for useChat
  const selectedModel = useModelProvider((state) => state.selectedModel)
  const selectedProvider = useModelProvider((state) => state.selectedProvider)
  const getProviderByName = useModelProvider((state) => state.getProviderByName)
  const threadRef = useRef(thread)
  const initialMessageRequiresHydrationRef = useRef(
    Boolean(
      sessionStorage.getItem(
        `${SESSION_STORAGE_PREFIX.INITIAL_MESSAGE}${threadId}`
      ) || readDivoTeachPendingMessage(thread?.metadata)
    )
  )
  const [messagesHydrated, setMessagesHydrated] = useState(
    !initialMessageRequiresHydrationRef.current
  )
  const projectId = threadRef.current?.metadata?.project?.id

  // Get system message from thread's assistant instructions (if thread has an assigned assistant)
  // Only use assistant instructions if the thread was created with one (e.g., via a project)
  const threadAssistant = thread?.assistants?.[0]
  const systemMessage = threadAssistant?.instructions
    ? renderInstructions(threadAssistant.instructions)
    : undefined

  useEffect(() => {
    threadRef.current = thread
  }, [thread])

  // Holds the partial assistant message while the model reloads after a
  // context-limit hit, so the user sees it instead of a blank gap.
  const [pendingContinueMessage, setPendingContinueMessage] =
    useState<UIMessage | null>(null)
  const [contextLimitError, setContextLimitError] = useState<Error | null>(null)
  // Per-thread so the shimmer survives navigating away and back while the
  // embedding run is still in flight.
  const processingEmbeddings = useAppState(
    (s) => !!s.embeddingThreads[threadId]
  )
  const { t } = useTranslation()

  // llama-server's overflow string is raw English; localize it, interpolating
  // the parsed request/context token counts when available.
  const contextBannerMessage = useMemo(() => {
    const raw = contextLimitError?.message
    if (!raw) return undefined
    const info = parseContextOverflow(raw)
    if (info)
      return t('model-errors:contextOverflowDetail', {
        request: info.requestTokens.toLocaleString(),
        context: info.contextTokens.toLocaleString(),
      })
    return t('model-errors:contextOverflowGeneric')
  }, [contextLimitError, t])

  // Refs so onFinish (captured in closure) always calls the latest callbacks
  const oomErrorRaw = useAppState((s) => s.oomError)
  const setOomError = useAppState((s) => s.setOomError)
  const backendErrorRaw = useAppState((s) => s.backendError)
  const setBackendError = useAppState((s) => s.setBackendError)

  // These signals come from the llamacpp router via global Tauri events.
  // Mask them when the active provider isn't llamacpp so a router crash
  // doesn't decorate chats running against MLX / OpenAI / Anthropic / etc.
  const isLlamacppActive = selectedProvider === 'llamacpp'
  const oomError = isLlamacppActive ? oomErrorRaw : undefined
  const backendError = isLlamacppActive ? backendErrorRaw : undefined

  const handleContextSizeIncreaseRef = useRef<(() => void) | null>(null)
  const setContinueFromContentRef = useRef<((content: string) => void) | null>(
    null
  )
  // Holds the partial assistant output captured when the model stops with
  // `finishReason === 'length'`. Consumed by `handleContextSizeIncrease` so
  // the manual "Increase Context Size" button resumes from where the stream
  // stopped rather than regenerating from scratch.
  const pendingContinuationRef = useRef<{
    message: UIMessage
    text: string
  } | null>(null)
  // Set before a generation when the resulting assistant message should be
  // linked to a specific parent (versioning). Consumed once in onFinish.
  const pendingAssistantParentId = useRef<string | null>(null)
  // `isAbort` is also used for unmounts and system-triggered stops. Only the
  // composer Stop button should turn a partial response into durable
  // interrupted history.
  const userStopRequestedRef = useRef(false)

  /**
   * Store meaningful Pi output while it is still arriving. The final onFinish
   * path replaces this record with the completed response, but if the desktop
   * exits first, the checkpoint is enough to restore the conversation exactly
   * as far as the user had seen it.
   */
  const persistPiStreamCheckpoint = (message: UIMessage) => {
    if (!uiMessageHasMeaningfulContent(message)) return

    const messageMetadata = (message.metadata || {}) as Record<string, unknown>
    const existingMessages = useMessages.getState().getMessages(threadId)
    const existingMessage = existingMessages.find((m) => m.id === message.id)
    const existingParent = existingMessage
      ? getParentId(existingMessage)
      : undefined

    let parentForAssistant = existingParent ?? pendingAssistantParentId.current
    if (
      parentForAssistant == null &&
      hasBranching(existingMessages)
    ) {
      parentForAssistant = resolveAssistantParent(undefined)
    }

    const assistantMessage: ThreadMessage = {
      type: 'text',
      role: ChatCompletionRole.Assistant,
      content: extractContentPartsFromUIMessage(message),
      id: message.id,
      object: 'thread.message',
      thread_id: threadId,
      status: MessageStatus.Ready,
      created_at: existingMessage?.created_at || Date.now(),
      completed_at: Date.now(),
      metadata:
        parentForAssistant != null
          ? {
              ...withPiStreamCheckpoint(messageMetadata),
              parentId: parentForAssistant,
            }
          : withPiStreamCheckpoint(messageMetadata),
    }

    if (existingMessage) {
      updateMessage(assistantMessage)
      return
    }

    addMessage(assistantMessage)
    if (parentForAssistant) {
      const parent = existingMessages.find((m) => m.id === parentForAssistant)
      if (parent) updateMessage(withActiveChild(parent, assistantMessage.id))
    }
  }

  // Use the AI SDK chat hook
  const {
    messages: chatMessages,
    status,
    error,
    sendMessage,
    regenerate,
    setMessages: setChatMessages,
    stop,
    addToolOutput,
    updateRagToolsAvailability,
    setContinueFromContent,
  } = useChat({
    sessionId: threadId,
    sessionTitle: thread?.title,
    systemMessage,
    experimental_throttle: 50,
    onFinish: ({ message, isAbort }) => {
      const msgMeta = message.metadata as Record<string, unknown> | undefined
      const finishReason = msgMeta?.finishReason as string | undefined
      const wasUserStopped = isAbort && userStopRequestedRef.current
      if (isAbort) userStopRequestedRef.current = false

      // Context limit hit: send partial content as prefill so the model continues
      // from where it stopped. The stream wrapper injects it as the first text-delta
      // of the new message, so the user sees the partial text immediately.
      if (!isAbort && finishReason === 'length') {
        const selectedModelState = useModelProvider.getState().selectedModel
        const usage = msgMeta?.usage as
          | { inputTokens?: number; outputTokens?: number }
          | undefined
        const totalTokens =
          (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)
        const ctxLen =
          (selectedModelState?.settings?.ctx_len?.controller_props
            ?.value as number) ?? 32768
        const isContextLimit = totalTokens >= ctxLen * 0.9

        if (isContextLimit) {
          // Stash the partial so the manual "Increase Context Size" button can
          // resume from here. Surface the standard banner with the manual
          // button — auto-increase was removed; the user explicitly opts in.
          const partialText = message.parts
            .filter((p) => p.type === 'text')
            .map((p) => (p as { type: 'text'; text: string }).text)
            .join('')
          if (partialText) {
            pendingContinuationRef.current = { message, text: partialText }
          }
          stampContextErrorOnThread(threadId)
          setContextLimitError(new Error(OUT_OF_CONTEXT_SIZE))
        }
        return
      }

      if (!isAbort && message.parts.length) setPendingContinueMessage(null)

      // Persist normal responses and meaningful partial output from an explicit
      // user stop. Other aborts (route teardown, provider shutdown, etc.) stay
      // transient. Tool/trace parts are stored verbatim as historical evidence;
      // no continuation or automatic replay is started for an interrupted run.
      // For continuations, message.parts already contains partial + new content
      // because the stream wrapper prepended the partial text as the first delta.
      if (
        (!isAbort || wasUserStopped) &&
        message.role === 'assistant' &&
        uiMessageHasMeaningfulContent(message)
      ) {
        const contentParts = extractContentPartsFromUIMessage(message)
        const messageMetadata = (message.metadata || {}) as Record<
          string,
          unknown
        >

        let parentForAssistant = pendingAssistantParentId.current
        pendingAssistantParentId.current = null

        // Never persist a detached assistant in a branched thread: if the
        // pending link was lost (e.g. a multi-step turn consumed the ref before
        // this reply finished), fall back to the user message this reply
        // answers. A null parentId would make computeActivePath treat the
        // assistant as a phantom root and drop it from the visible path.
        if (
          parentForAssistant == null &&
          hasBranching(useMessages.getState().getMessages(threadId))
        ) {
          parentForAssistant = resolveAssistantParent(undefined)
        }

        const persistedMetadata = wasUserStopped
          ? {
              ...messageMetadata,
              interrupted: true,
              interruption: {
                state: 'interrupted',
                reason: 'user_stop',
              },
            }
          : messageMetadata

        const assistantMessage: ThreadMessage = {
          type: 'text',
          role: ChatCompletionRole.Assistant,
          content: contentParts,
          id: message.id,
          object: 'thread.message',
          thread_id: threadId,
          status: MessageStatus.Ready,
          created_at: Date.now(),
          completed_at: Date.now(),
          metadata:
            parentForAssistant != null
              ? { ...persistedMetadata, parentId: parentForAssistant }
              : persistedMetadata,
        }

        const existingMessages = useMessages.getState().getMessages(threadId)
        const existingMessage = existingMessages.find(
          (m) => m.id === message.id
        )

        if (existingMessage) {
          // Preserve the existing branch link on re-runs of onFinish.
          const existingParent = getParentId(existingMessage)
          updateMessage(
            existingParent != null
              ? {
                  ...assistantMessage,
                  metadata: {
                    ...assistantMessage.metadata,
                    parentId: existingParent,
                  },
                }
              : assistantMessage
          )
        } else {
          addMessage(assistantMessage)
          // New generation becomes the active branch under its parent so
          // version navigation lands on the latest reply by default.
          if (parentForAssistant) {
            const parent = existingMessages.find(
              (m) => m.id === parentForAssistant
            )
            if (parent) updateMessage(withActiveChild(parent, assistantMessage.id))
          }
        }

        for (const m of existingMessages) {
          const meta = m.metadata as Record<string, unknown> | undefined
          if (meta?.error) {
            const rest = { ...meta }
            delete rest.error
            updateMessage({ ...m, metadata: rest })
          }
          useMessageErrors.getState().clearError(m.id)
        }
      }

      // A stop is terminal user intent. In particular, do not feed completed
      // Pi tool parts back into a new run or kick off client-side tool work.
      if (isAbort) return

      // Create a new AbortController for tool calls
      toolCallAbortController.current = new AbortController()
      const signal = toolCallAbortController.current.signal

      // Get cached tool names from store (initialized in useTools hook)
      const ragToolNames = useAppState.getState().ragToolNames
      const mcpToolNames = useAppState.getState().mcpToolNames

      // Keep the thread marked busy while awaiting approval and executing tools,
      // since streaming has already ended and isSessionBusy's tools-array read isn't reactive.
      useAppState.getState().setThreadBusy(threadId, true)

      // Process tool calls sequentially, requesting approval for each if needed
      ;(async () => {
        for (const toolCall of sessionData.tools) {
          // Check if already aborted before starting
          if (signal.aborted) {
            break
          }

          try {
            const toolName = toolCall.toolName

            // Built-in RAG tools are internal and should not require approval.
            const approved = ragToolNames.has(toolName)
              ? true
              : await useToolApproval
                  .getState()
                  .requestApproval(toolCall.toolCallId, toolName, threadId)

            if (!approved) {
              // User denied the tool call
              addToolOutput({
                state: 'output-error',
                tool: toolCall.toolName,
                toolCallId: toolCall.toolCallId,
                errorText: 'Tool execution denied by user',
              })
              continue
            }

            let result

            // Route to the appropriate service based on tool name
            if (ragToolNames.has(toolName)) {
              result = await serviceHub.rag().callTool({
                toolName,
                arguments: toolCall.input,
                threadId,
                projectId: projectId,
                scope: projectId ? 'project' : 'thread',
              })
            } else if (mcpToolNames.has(toolName)) {
              result = await serviceHub.mcp().callTool({
                toolName,
                arguments: toolCall.input,
              })
            } else {
              // Tool not found in either service
              result = {
                error: `Tool '${toolName}' not found in any service`,
              }
            }

            if (result.error) {
              addToolOutput({
                state: 'output-error',
                tool: toolCall.toolName,
                toolCallId: toolCall.toolCallId,
                errorText: `Error: ${result.error}`,
              })
            } else {
              addToolOutput({
                tool: toolCall.toolName,
                toolCallId: toolCall.toolCallId,
                output: result.content,
              })
            }
          } catch (error) {
            // Ignore abort errors
            if ((error as Error).name !== 'AbortError') {
              console.error('Tool call error:', error)
              addToolOutput({
                state: 'output-error',
                tool: toolCall.toolName,
                toolCallId: toolCall.toolCallId,
                errorText: `Error: ${JSON.stringify(error)}`,
              })
            }
          }
        }

        // Clear tools after processing all
        sessionData.tools = []
        toolCallAbortController.current = null
        useAppState.getState().setThreadBusy(threadId, false)
      })().catch((error) => {
        // Ignore abort errors
        if (error.name !== 'AbortError') {
          console.error('Tool call error:', error)
        }
        sessionData.tools = []
        toolCallAbortController.current = null
        useAppState.getState().setThreadBusy(threadId, false)
      })

      if (!isAbort) {
        const localMessages = useMessages.getState().getMessages(threadId)
        const assistantCount = localMessages.filter(
          (m) => m.role === 'assistant'
        ).length
        const isRefreshTick =
          assistantCount === 1 ||
          (assistantCount > 0 &&
            assistantCount % TITLE_REFRESH_EVERY_N_ASSISTANT_MESSAGES === 0)
        const currentThread = useThreads.getState().threads[threadId]
        if (isRefreshTick && !currentThread?.metadata?.titleSetManually) {
          const TITLE_TRANSCRIPT_MAX_TURNS = 8
          const recent = localMessages.slice(-TITLE_TRANSCRIPT_MAX_TURNS)
          const inputText =
            recent
              .map((m) => {
                const text = m.content
                  ?.map((c) => c?.text?.value ?? '')
                  .join('')
                  .trim()
                if (!text) return ''
                const role = m.role === 'assistant' ? 'Assistant' : 'User'
                return `${role}: ${text}`
              })
              .filter(Boolean)
              .join('\n\n') ||
            useThreads.getState().threads[threadId]?.title
          if (inputText) {
            const provider = useModelProvider.getState().selectedProvider
            const modelId = useModelProvider.getState().selectedModel?.id
            ;(async () => {
              if (provider === 'llamacpp' && modelId) {
                let idle = false
                for (let attempt = 0; attempt < 6; attempt++) {
                  try {
                    idle = await invoke<boolean>(
                      'plugin:llamacpp|router_slots_idle',
                      { modelId }
                    )
                  } catch {
                    idle = true
                    break
                  }
                  if (idle) break
                  await new Promise((r) => setTimeout(r, 150))
                }
                if (!idle) return
              }
              titleAbortRef.current?.abort()
              const controller = new AbortController()
              titleAbortRef.current = controller
              const title = await generateThreadTitle(
                inputText,
                controller.signal
              )
              if (!title || controller.signal.aborted) return
              useThreads.getState().updateThread(threadId, { title })
              titleAbortRef.current = null
            })()
          }
        }
      }
    },
    onToolCall: ({ toolCall }) => {
      if (selectedProvider === 'pi') return
      sessionData.tools.push(toolCall)
    },
    sendAutomaticallyWhen: followUpMessage,
  })

  // Our error banners (oom/backend/context) can arrive out-of-band for the
  // router path, leaving the SDK stream stuck at 'submitted' so the
  // "Using tools…" indicator shimmers forever. Force a terminal status when a
  // banner is up — regenerate/reload restarts the turn anyway.
  const hasBannerError = !!(oomError || backendError || contextLimitError)
  const isPiRuntimeActive = useAppState(
    (state) =>
      threadId in state.busyThreads || threadId in state.piThreadRunStates
  )
  const lastChatMessage = chatMessages[chatMessages.length - 1]
  const hasSettledPiAssistant = Boolean(
    lastChatMessage?.role === 'assistant' &&
      isPiTraceMessage(
        lastChatMessage.metadata as Record<string, unknown> | undefined
      )
  )
  // The AI SDK hook can briefly retain the previously selected chat's status
  // while its Chat subscription moves between thread-scoped instances. Pi's
  // runtime ownership is the authoritative live signal: once that marker is
  // gone, a completed assistant turn must render as history even if the cached
  // SDK status still says submitted/streaming.
  const hasStalePiStatus =
    (status === CHAT_STATUS.SUBMITTED || status === CHAT_STATUS.STREAMING) &&
    hasSettledPiAssistant &&
    !isPiRuntimeActive
  const effectiveStatus =
    hasBannerError || hasStalePiStatus ? 'ready' : status

  // The AI SDK keeps streamed assistant content in browser memory until the
  // generation ends. Checkpoint Pi-owned output as it changes, but only while
  // the runtime still owns this thread; historical messages with a stale SDK
  // status must never be re-written as in-progress work.
  useEffect(() => {
    if (!isPiRuntimeActive) return

    const inFlightAssistant = [...chatMessages]
      .reverse()
      .find(
        (message) =>
          message.role === 'assistant' &&
          isPiTraceMessage(
            message.metadata as Record<string, unknown> | undefined
          )
      )
    if (!inFlightAssistant) return

    persistPiStreamCheckpoint(inFlightAssistant)
    // `persistPiStreamCheckpoint` intentionally reads current stores and
    // thread-local refs so it can be called for every streamed snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatMessages, isPiRuntimeActive, threadId])

  // Get disabled tools for this thread to trigger re-render when they change
  const disabledTools = useToolAvailable((state) =>
    state.getDisabledToolsForThread(threadId)
  )

  // Update RAG tools availability when documents, model, or tool availability changes
  useEffect(() => {
    const checkDocumentsAvailability = async () => {
      const hasThreadDocuments = Boolean(thread?.metadata?.hasDocuments)
      let hasProjectDocuments = false

      // Check if thread belongs to a project and if that project has files
      const projectId = thread?.metadata?.project?.id
      if (projectId) {
        try {
          const ext = ExtensionManager.getInstance().get<VectorDBExtension>(
            ExtensionTypeEnum.VectorDB
          )
          if (ext?.listAttachmentsForProject) {
            const projectFiles = await ext.listAttachmentsForProject(projectId)
            hasProjectDocuments = projectFiles.length > 0
          }
        } catch (error) {
          console.warn('Failed to check project files:', error)
        }
      }

      const hasDocuments = hasThreadDocuments || hasProjectDocuments
      const ragFeatureAvailable = Boolean(useAttachments.getState().enabled)
      const modelSupportsTools =
        selectedModel?.capabilities?.includes('tools') ?? false

      updateRagToolsAvailability(
        hasDocuments,
        modelSupportsTools,
        ragFeatureAvailable
      )
    }

    checkDocumentsAvailability()
  }, [
    thread?.metadata?.hasDocuments,
    thread?.metadata?.project?.id,
    selectedModel?.capabilities,
    updateRagToolsAvailability,
    disabledTools, // Re-run when tools are enabled/disabled
  ])

  // Auto-scroll the reasoning container during streaming, pausing when the user scrolls up
  const {
    containerRef: reasoningContainerRef,
    isAtBottom: isReasoningAtBottom,
    handleScroll: handleReasoningScroll,
    scrollToBottom: scrollReasoningToBottom,
    forceScrollToBottom: forceScrollReasoningToBottom,
    reset: resetReasoningScroll,
  } = useAutoScroll()

  const lastAssistantHasVisibleActivity = useMemo(() => {
    const last = chatMessages[chatMessages.length - 1]
    if (!last || last.role !== 'assistant') return false
    return last.parts.some((part) => {
      if (part.type === 'text' || part.type === 'reasoning') {
        return Boolean(
          'text' in part &&
            typeof part.text === 'string' &&
            part.text.trim()
        )
      }
      // A tool or file card is already a visible activity indicator. Unknown
      // protocol markers remain invisible and must not suppress “Working…”.
      return part.type.startsWith('tool-') || part.type === 'file'
    })
  }, [chatMessages])

  useEffect(() => {
    if (status === 'streaming') {
      resetReasoningScroll()
    }
  }, [status, resetReasoningScroll])

  useEffect(() => {
    if (status === 'streaming') {
      scrollReasoningToBottom()
    }
  }, [status, chatMessages, scrollReasoningToBottom])

  // Pin the latest user turn to the top of the viewport on send, so its reply
  // (working status + answer) streams into view without a manual scroll. Only
  // fires for genuine sends — loading a thread keeps the normal bottom view.
  const lastUserMessageId = useMemo(() => {
    for (let i = chatMessages.length - 1; i >= 0; i--) {
      if (chatMessages[i].role === 'user') return chatMessages[i].id
    }
    return null
  }, [chatMessages])

  const [pinId, setPinId] = useState<string | null>(null)
  const [pinNonce, setPinNonce] = useState(0)
  const seenUserMessageRef = useRef<string | null>(null)

  // Reset pinning when switching threads so a freshly opened thread shows its
  // latest answer at the bottom rather than pinning a historical turn.
  useEffect(() => {
    setPinId(null)
    setPinNonce(0)
    seenUserMessageRef.current = null
  }, [threadId])

  useEffect(() => {
    if (!lastUserMessageId) return
    if (lastUserMessageId === seenUserMessageRef.current) return
    const isFreshSend = status === 'submitted' || status === 'streaming'
    seenUserMessageRef.current = lastUserMessageId
    if (isFreshSend) {
      setPinId(lastUserMessageId)
      setPinNonce((n) => n + 1)
    }
  }, [lastUserMessageId, status])

  useEffect(() => {
    setCurrentThreadId(threadId)
    titleAbortRef.current?.abort()
    titleAbortRef.current = null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId])

  // Load messages on first mount
  useEffect(() => {
    if (initialMessageRequiresHydrationRef.current) {
      setMessagesHydrated(false)
    }
    // Skip if chat already has messages (e.g., returning to a streaming conversation)
    const existingSession = useChatSessions.getState().sessions[threadId]
    if (
      existingSession?.chat.messages.length > 0 ||
      existingSession?.isStreaming ||
      currentThread.current === threadId
    ) {
      if (initialMessageRequiresHydrationRef.current) {
        setMessagesHydrated(true)
      }
      return
    }

    let active = true
    serviceHub
      .messages()
      .fetchMessages(threadId)
      .then((fetchedMessages) => {
        if (fetchedMessages && fetchedMessages.length > 0) {
          const currentLocalMessages = useMessages
            .getState()
            .getMessages(threadId)

          let messagesToSet = fetchedMessages

          // Merge with local-only messages if needed
          if (currentLocalMessages && currentLocalMessages.length > 0) {
            const fetchedIds = new Set(fetchedMessages.map((m) => m.id))
            const localOnlyMessages = currentLocalMessages.filter(
              (m) => !fetchedIds.has(m.id)
            )

            if (localOnlyMessages.length > 0) {
              messagesToSet = [...fetchedMessages, ...localOnlyMessages].sort(
                (a, b) => (a.created_at || 0) - (b.created_at || 0)
              )
            }
          }

          // Drop and delete any persisted empty assistant rows produced by
          // the old bug where errored generations were written as empty-text
          // messages. Lossless cleanup — these carry no information.
          const emptyAssistantIds = messagesToSet
            .filter(threadMessageIsEmpty)
            .map((m) => m.id)
          if (emptyAssistantIds.length > 0) {
            messagesToSet = messagesToSet.filter(
              (m) => !emptyAssistantIds.includes(m.id)
            )
            for (const id of emptyAssistantIds) {
              deleteMessage(threadId, id)
            }
          }

          // A persisted checkpoint means Pi was still streaming when the
          // desktop last disappeared. Pi is process-scoped, so that run cannot
          // resume on launch. Keep the exact visible output, mark it honestly
          // as incomplete, and require an explicit user follow-up instead of
          // replaying a potentially side-effectful task.
          const recoveredCheckpoints = messagesToSet
            .filter((message) => {
              const metadata = message.metadata as
                | Record<string, unknown>
                | undefined
              return (
                message.role === ChatCompletionRole.Assistant &&
                isPiStreamCheckpoint(metadata)
              )
            })
            .map((message) => ({
              ...message,
              metadata: recoverPiStreamCheckpoint(
                (message.metadata ?? {}) as Record<string, unknown>
              ),
            }))
          if (recoveredCheckpoints.length > 0) {
            const recoveredById = new Map(
              recoveredCheckpoints.map((message) => [message.id, message])
            )
            messagesToSet = messagesToSet.map(
              (message) => recoveredById.get(message.id) ?? message
            )
            for (const message of recoveredCheckpoints) {
              updateMessage(message)
            }
          }

          // Migrate threads corrupted by the pre-#8357 bug: assistant replies
          // saved with parentId:null are phantom roots that computeActivePath
          // drops. Re-parent them to the user turn they answer and persist.
          const repaired = repairDetachedAssistants(messagesToSet)
          if (repaired.length > 0) {
            const byId = new Map(repaired.map((m) => [m.id, m]))
            messagesToSet = messagesToSet.map((m) => byId.get(m.id) ?? m)
            for (const m of repaired) updateMessage(m)
          }

          setMessages(threadId, messagesToSet)

          const hydrated: Record<string, string> = {}
          for (const m of messagesToSet) {
            const err = (m.metadata as Record<string, unknown> | undefined)
              ?.error
            if (typeof err === 'string' && err.length > 0) {
              hydrated[m.id] = err
            }
          }
          useMessageErrors.getState().hydrate(hydrated)

          const activeRootId = (
            useThreads.getState().threads[threadId]?.metadata as
              | Record<string, unknown>
              | undefined
          )?.activeRootId as string | undefined
          const uiMessages = convertThreadMessagesToUIMessages(
            computeActivePath(messagesToSet, activeRootId)
          )
          setChatMessages(uiMessages)
        }
      })
      .catch((error) =>
        console.error('Failed to fetch messages for thread:', threadId, error)
      )
      .finally(() => {
        if (!active) return
        currentThread.current = threadId
        if (initialMessageRequiresHydrationRef.current) {
          setMessagesHydrated(true)
        }
      })
    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, serviceHub])

  useEffect(() => {
    return () => {
      titleAbortRef.current?.abort()
      setCurrentThreadId(undefined)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Resync the OOM/backend banner from message metadata on every thread switch.
  // Persisted by LlamacppOomListener at error time; unset state when this
  // thread carries no such metadata so the banner doesn't leak across threads.
  const threadMessagesForBanner = useMessages((s) => s.messages?.[threadId])
  useEffect(() => {
    let oom: string | undefined
    let be: string | undefined
    let ctx: string | undefined
    for (const m of threadMessagesForBanner ?? []) {
      const meta = m.metadata as Record<string, unknown> | undefined
      const o = meta?.oomError
      if (typeof o === 'string' && o.length > 0) oom = o
      const b = meta?.backendError
      if (typeof b === 'string' && b.length > 0) be = b
      const c = meta?.contextError
      if (typeof c === 'string' && c.length > 0) ctx = c
    }
    useAppState.getState().setOomError(oom)
    useAppState.getState().setBackendError(be)
    setContextLimitError(ctx ? new Error(ctx) : null)
  }, [threadId, threadMessagesForBanner])

  // Consolidated function to process and send a message
  const processAndSendMessage = useCallback(
    async (
      text: string,
      files?: Array<{ type: string; mediaType: string; url: string }>,
      options?: DivoSkillReferenceSubmitOptions,
      queuedMessage?: QueuedMessage,
      assertCanSubmit?: () => void,
      onSubmissionAccepted?: () => void
    ) => {
      userStopRequestedRef.current = false
      assertCanSubmit?.()
      const currentMessages = useMessages.getState().getMessages(threadId)
      if (
        queuedMessage?.parentId != null &&
        !currentMessages.some(
          (message) => message.id === queuedMessage.parentId
        )
      ) {
        throw new QueuedBranchParentMissingError()
      }
      const skillReferences = normalizeDivoSkillReferences(
        queuedMessage
          ? queuedMessage.skillReferences.map((reference) => ({
              ...reference,
              toolIds: [...reference.toolIds],
            }))
          : options?.skillReferences
      )
      const skillReferenceMetadata =
        skillReferences.length > 0
          ? { [DIVO_SKILL_REFERENCES_METADATA_KEY]: skillReferences }
          : {}
      const quickStartMetadata = options?.quickStartPlan
        ? { [DIVO_QUICK_START_METADATA_KEY]: options.quickStartPlan }
        : {}
      const callerMessageMetadata = options?.messageMetadata ?? {}

      // Cancel any in-flight title summarization so it doesn't compete with this request
      titleAbortRef.current?.abort()
      titleAbortRef.current = null

      // Get all attachments from the store (media transferred from the
      // new-thread key, plus documents).
      const allAttachments: Attachment[] = queuedMessage
        ? queuedMessage.attachments.map((attachment) => ({ ...attachment }))
        : getAttachments(attachmentsKey)

      // In-thread sends pass media inline via `files`; reconstruct typed by
      // mediaType (image/audio/video — not all images). New-thread sends pass
      // no media in `files` (quota), so fall back to media already in the store.
      const fileMediaAttachments = (files ?? []).map((file) => {
        const base64 = file.url.split(',')[1] || ''
        const size = Math.ceil((base64.length * 3) / 4) // Estimate from base64
        if (file.mediaType.startsWith('audio/')) {
          return createAudioAttachment({
            name: `audio-${Date.now()}`,
            mimeType: file.mediaType,
            dataUrl: file.url,
            base64,
            audioFormat: file.mediaType === 'audio/mpeg' ? 'mp3' : 'wav',
            size,
          })
        }
        if (file.mediaType.startsWith('video/')) {
          return createVideoAttachment({
            name: `video-${Date.now()}`,
            mimeType: file.mediaType,
            dataUrl: file.url,
            base64,
            size,
          })
        }
        return createImageAttachment({
          name: `image-${Date.now()}`,
          mimeType: file.mediaType,
          dataUrl: file.url,
          base64,
          size,
        })
      })

      const storeMediaAttachments = allAttachments.filter(
        (a) => a.type === 'image' || a.type === 'audio' || a.type === 'video'
      )
      const mediaAttachments = fileMediaAttachments.length
        ? fileMediaAttachments
        : storeMediaAttachments

      // Combine media attachments with document attachments from the store
      const combinedAttachments = [
        ...mediaAttachments,
        ...allAttachments.filter((a) => a.type === 'document'),
      ]

      const messageId = generateId()
      const hasDocuments = combinedAttachments.some(
        (a) => a.type === 'document' && !a.processed
      )
      const hasEmbeddingDocuments = combinedAttachments.some(
        (a) =>
          a.type === 'document' &&
          !a.processed &&
          a.parseMode !== 'inline'
      )

      // When there are unprocessed documents (e.g. first-message flow),
      // show the user message in the conversation immediately so the UI
      // doesn't hang while embeddings are generated.
      if (hasDocuments) {
        const previewMessage = newUserThreadContent(
          threadId,
          text,
          combinedAttachments,
          messageId
        )
        previewMessage.metadata = {
          ...(previewMessage.metadata ?? {}),
          ...skillReferenceMetadata,
          ...quickStartMetadata,
        }
        const previewUI =
          convertThreadMessagesToUIMessages([previewMessage])
        setChatMessages((prev) => [...prev, ...previewUI])
      }

      // Immediate sends transfer ownership from the composer here. Queued
      // sends already detached their snapshot when they entered the queue.
      if (!queuedMessage) clearAttachmentsForThread(attachmentsKey)

      // Process attachments (ingest images, parse/index documents)
      let processedAttachments = combinedAttachments
      const projectId = thread?.metadata?.project?.id
      const shouldProcessAttachments =
        combinedAttachments.length > 0 && selectedProvider !== 'pi'
      if (shouldProcessAttachments) {
        if (hasEmbeddingDocuments) {
          useAppState.getState().setThreadEmbedding(threadId, true)
          useAppState.getState().setThreadBusy(threadId, true)
        }
        try {
          const parsePreference = useAttachments.getState().parseMode
          const result = await processAttachmentsForSend({
            attachments: combinedAttachments,
            threadId,
            projectId,
            serviceHub,
            parsePreference,
          })
          processedAttachments = result.processedAttachments

          // Update thread metadata if documents were embedded
          if (result.hasEmbeddedDocuments) {
            const toolApproval = useToolApproval.getState()
            const ragTools = useAppState.getState().ragToolNames
            for (const toolName of ragTools) {
              toolApproval.approveToolForThread(threadId, toolName)
            }
            useThreads.getState().updateThread(threadId, {
              metadata: { hasDocuments: true },
            })
          }
        } catch (error) {
          console.error('Failed to process attachments:', error)
          // Remove the preview message on failure
          if (hasDocuments) {
            setChatMessages((prev) =>
              prev.filter((m) => m.id !== messageId)
            )
          }
          if (queuedMessage) throw error
          return
        } finally {
          useAppState.getState().setThreadEmbedding(threadId, false)
          useAppState.getState().setThreadBusy(threadId, false)
        }
      }

      // Remove the preview before sendMessage adds the real user message
      // with the same id — this prevents duplicates.
      if (hasDocuments) {
        setChatMessages((prev) => prev.filter((m) => m.id !== messageId))
      }

      // Attachment processing can take long enough for a branch deletion or
      // queue cancellation to race with it. Check both at the final boundary,
      // before writing the message or handing it to the AI SDK.
      assertCanSubmit?.()
      const messagesBeforeSend = useMessages.getState().getMessages(threadId)
      if (
        queuedMessage?.parentId != null &&
        !messagesBeforeSend.some(
          (message) => message.id === queuedMessage.parentId
        )
      ) {
        throw new QueuedBranchParentMissingError()
      }

      // Persist the final message to backend
      const baseUserMessage = newUserThreadContent(
        threadId,
        text,
        processedAttachments,
        messageId
      )
      baseUserMessage.metadata = {
        ...(baseUserMessage.metadata ?? {}),
        ...callerMessageMetadata,
        ...skillReferenceMetadata,
        ...quickStartMetadata,
      }
      // Once a thread has branches, link new turns into the active path so the
      // assistant reply attaches to this message. Legacy threads stay linear.
      const branchedMessages = useMessages.getState().getMessages(threadId)
      let userMessage = baseUserMessage
      if (hasBranching(branchedMessages) || queuedMessage?.hadBranching) {
        const activeRootId = (
          useThreads.getState().threads[threadId]?.metadata as
            | Record<string, unknown>
            | undefined
        )?.activeRootId as string | undefined
        const path = computeActivePath(branchedMessages, activeRootId)
        const parentId = queuedMessage
          ? queuedMessage.parentId
          : path.length
            ? path[path.length - 1].id
            : null
        userMessage = {
          ...baseUserMessage,
          metadata: { ...(baseUserMessage.metadata ?? {}), parentId },
        }
        pendingAssistantParentId.current = messageId
      }
      addMessage(userMessage)

      if (queuedMessage?.parentId) {
        const messagesWithQueuedTurn = useMessages
          .getState()
          .getMessages(threadId)
        const parent = messagesWithQueuedTurn.find(
          (message) => message.id === queuedMessage.parentId
        )
        if (!parent) throw new QueuedBranchParentMissingError()

        // Re-select every ancestor down to the captured parent before adding
        // this turn. Otherwise a sibling selected while the item waited would
        // remain the visible/model context despite the persisted parent link.
        const byId = new Map(
          messagesWithQueuedTurn.map((message) => [message.id, message])
        )
        let childId = userMessage.id
        let current: ThreadMessage | undefined = parent
        const seen = new Set<string>()
        while (current && !seen.has(current.id)) {
          seen.add(current.id)
          updateMessage(withActiveChild(current, childId))
          childId = current.id
          const parentId = getParentId(current)
          current = parentId ? byId.get(parentId) : undefined
        }
        const rootId = findBranchRootId(messagesWithQueuedTurn, parent.id)
        if (rootId) {
          const currentThread = useThreads.getState().threads[threadId]
          useThreads.getState().updateThread(threadId, {
            metadata: {
              ...((currentThread?.metadata as Record<string, unknown>) ?? {}),
              activeRootId: rootId,
            },
          })
        }
        const activatedMessages = useMessages.getState().getMessages(threadId)
        const activatedPath = computeActivePath(activatedMessages, rootId)
        // sendMessage appends the queued user turn itself. Preloading it here
        // would make AI SDK v6 append the same id a second time to provider
        // context, so prime only the captured ancestor path.
        setChatMessages(
          convertThreadMessagesToUIMessages(activatedPath.slice(0, -1))
        )
      }

      // Build parts for AI SDK. Derive media file parts from the resolved
      // attachments (not the raw `files` arg) so the first-message flow — where
      // media lives in the store and `files` is empty — still renders live.
      const parts: Array<
        | { type: 'text'; text: string }
        | { type: 'file'; mediaType: string; url: string }
      > = [
        {
          type: 'text',
          text: userMessage.content[0].text?.value ?? text,
        },
      ]

      mediaAttachments.forEach((a) => {
        if (a.dataUrl && a.mimeType) {
          parts.push({
            type: 'file',
            mediaType: a.mimeType,
            url: a.dataUrl,
          })
        }
      })

      let submissionAccepted = false
      try {
        const sendPromise = sendMessage(
          {
            parts,
            id: messageId,
            metadata: { ...userMessage.metadata, createdAt: new Date() },
          },
          onSubmissionAccepted
            ? { body: { __divoOnStreamAccepted: () => {
                submissionAccepted = true
                onSubmissionAccepted()
              } } }
            : undefined
        )
        await sendPromise
        if (queuedMessage && onSubmissionAccepted && !submissionAccepted) {
          throw new QueuedSubmissionNotAcceptedError()
        }
      } catch (error) {
        // Only a synchronous handoff failure is pre-acceptance. The queue
        // callback is invoked first for accepted sends, so late failures keep
        // their user/assistant evidence and never re-enter the queue.
        if (queuedMessage && !submissionAccepted) {
          deleteMessage(threadId, messageId)
          setChatMessages((previous) =>
            previous.filter((message) => message.id !== messageId)
          )
        }
        throw error
      }
    },
    [
      sendMessage,
      threadId,
      thread,
      addMessage,
      getAttachments,
      attachmentsKey,
      setChatMessages,
      clearAttachmentsForThread,
      serviceHub,
      selectedProvider,
      deleteMessage,
      updateMessage,
    ]
  )

  // Check for and send a pending first turn. Normal new chats use
  // sessionStorage; Teach also persists this handoff in thread metadata so a
  // route change or webview refresh cannot lose the analysis request.
  const initialMessageSentRef = useRef(false)

  useEffect(() => {
    // Prevent duplicate sends
    if (initialMessageSentRef.current || !messagesHydrated) return

    const initialMessageKey = `${SESSION_STORAGE_PREFIX.INITIAL_MESSAGE}${threadId}`
    const storedMessage = sessionStorage.getItem(initialMessageKey)
    const pendingTeachMessage = readDivoTeachPendingMessage(thread?.metadata)

    if (storedMessage || pendingTeachMessage) {
      const alreadyPersisted = pendingTeachMessage
        ? useMessages.getState().getMessages(threadId).some((message) =>
            (message.metadata as Record<string, unknown> | undefined)
              ?.divoTeachSessionId === pendingTeachMessage.teachSessionId
          )
        : false
      if (alreadyPersisted) {
        initialMessageSentRef.current = true
        sessionStorage.removeItem(initialMessageKey)
        void clearDivoTeachPendingMessage(threadId).catch((error) =>
          console.warn('Failed to clear completed Teach handoff:', error)
        )
        return
      }

      // Mark as sent immediately to prevent duplicate sends
      sessionStorage.removeItem(initialMessageKey)
      initialMessageSentRef.current = true

      // Process message asynchronously
      ;(async () => {
        try {
          const message = storedMessage
            ? JSON.parse(storedMessage) as {
                text: string
                files?: Array<{ type: string; mediaType: string; url: string }>
                skillReferences?: DivoSkillReference[]
                quickStartPlan?: DivoSkillReferenceSubmitOptions['quickStartPlan']
              }
            : { text: pendingTeachMessage!.text, files: [] }

          await processAndSendMessage(message.text, message.files, {
            skillReferences: message.skillReferences,
            quickStartPlan: message.quickStartPlan,
            messageMetadata: pendingTeachMessage
              ? { divoTeachSessionId: pendingTeachMessage.teachSessionId }
              : undefined,
          })
          if (pendingTeachMessage) {
            await clearDivoTeachPendingMessage(threadId)
          }
        } catch (error) {
          console.error('Failed to send initial message:', error)
        }
      })()
    }
  }, [messagesHydrated, processAndSendMessage, thread?.metadata, threadId])

  const stripBannerMetadata = useCallback(() => {
    const tmsgs = useMessages.getState().getMessages(threadId)
    for (const m of tmsgs) {
      const meta = m.metadata as Record<string, unknown> | undefined
      if (!meta) continue
      if (
        meta.oomError == null &&
        meta.backendError == null &&
        meta.contextError == null
      )
        continue
      const nextMeta = { ...meta }
      delete nextMeta.oomError
      delete nextMeta.backendError
      delete nextMeta.contextError
      updateMessage({ ...m, metadata: nextMeta })
    }
  }, [threadId, updateMessage])

  // Dismiss any active thread-level banner error and strip its persisted
  // metadata. The banner stands in for a failed last assistant turn (hidden by
  // the render filter), so leaving it set would blank a healthy assistant on
  // whatever branch we navigate to next.
  const clearBannerErrors = useCallback(() => {
    if (oomError) setOomError(undefined)
    if (backendError) setBackendError(undefined)
    if (contextLimitError) setContextLimitError(null)
    if (oomError || backendError || contextLimitError) stripBannerMetadata()
  }, [
    oomError,
    setOomError,
    backendError,
    setBackendError,
    contextLimitError,
    stripBannerMetadata,
  ])

  // Handle submit from ChatInput
  const handleSubmit = useCallback(
    async (
      text: string,
      files?: Array<{ type: string; mediaType: string; url: string }>,
      options?: DivoSkillReferenceSubmitOptions
    ) => {
      clearBannerErrors()
      await processAndSendMessage(text, files, options)
    },
    [processAndSendMessage, clearBannerErrors]
  )

  // Versioning helpers --------------------------------------------------------

  // Assign parentId along the current linear path the first time a thread forks,
  // so siblings and subtrees are well-defined. Idempotent. Returns the store.
  const ensureBranched = useCallback(() => {
    const msgs = useMessages.getState().getMessages(threadId)
    if (hasBranching(msgs)) return msgs
    const filled = backfillParentIds(msgs)
    filled.forEach((m) => updateMessage(m))
    return useMessages.getState().getMessages(threadId)
  }, [threadId, updateMessage])

  // Make `node` the active branch under its parent (or active root).
  const setActiveBranch = useCallback(
    (node: ThreadMessage) => {
      const parentId = getParentId(node)
      if (!parentId) {
        const t = useThreads.getState().threads[threadId]
        useThreads.getState().updateThread(threadId, {
          metadata: {
            ...((t?.metadata as Record<string, unknown> | undefined) ?? {}),
            activeRootId: node.id,
          },
        })
        return
      }
      const parent = useMessages
        .getState()
        .getMessages(threadId)
        .find((m) => m.id === parentId)
      if (parent) updateMessage(withActiveChild(parent, node.id))
    },
    [threadId, updateMessage]
  )

  // Rebuild the rendered conversation from the active path in the store.
  const syncActivePath = useCallback(() => {
    const msgs = useMessages.getState().getMessages(threadId)
    const activeRootId = (
      useThreads.getState().threads[threadId]?.metadata as
        | Record<string, unknown>
        | undefined
    )?.activeRootId as string | undefined
    setChatMessages(
      convertThreadMessagesToUIMessages(computeActivePath(msgs, activeRootId))
    )
  }, [threadId, setChatMessages])

  // Switch the visible version of a message (the `< n/m >` control).
  const handleSwitchVersion = useCallback(
    (messageId: string, dir: -1 | 1) => {
      const msgs = useMessages.getState().getMessages(threadId)
      const target = msgs.find((m) => m.id === messageId)
      if (!target) return
      const siblings = getSiblings(msgs, target)
      const idx = siblings.findIndex((m) => m.id === messageId)
      const next = siblings[idx + dir]
      if (!next) return
      titleAbortRef.current?.abort()
      titleAbortRef.current = null
      clearBannerErrors()
      setActiveBranch(next)
      syncActivePath()
    },
    [threadId, setActiveBranch, syncActivePath, clearBannerErrors]
  )

  // Resolve the user message that an assistant reply hangs off of.
  const resolveAssistantParent = useCallback(
    (messageId: string | undefined): string | null => {
      const msgs = useMessages.getState().getMessages(threadId)
      const activeRootId = (
        useThreads.getState().threads[threadId]?.metadata as
          | Record<string, unknown>
          | undefined
      )?.activeRootId as string | undefined
      const path = computeActivePath(msgs, activeRootId)
      const idx =
        messageId == null
          ? path.length - 1
          : path.findIndex((m) => m.id === messageId)
      if (idx === -1) return null
      const sel = path[idx]
      if (sel.role === 'user') return sel.id
      for (let i = idx; i >= 0; i--) {
        if (path[i].role === 'user') return path[i].id
      }
      return null
    },
    [threadId]
  )

  // Regenerate keeps the previous reply as a prior version (no deletion); the
  // new reply arrives in onFinish as a sibling and becomes the active branch.
  const handleRegenerate = useCallback(
    (messageId?: string) => {
      userStopRequestedRef.current = false
      const hadBannerError =
        useAppState.getState().oomError != null ||
        useAppState.getState().backendError != null ||
        contextLimitError != null
      if (useAppState.getState().oomError) {
        useAppState.getState().setOomError(undefined)
      }
      if (useAppState.getState().backendError) {
        useAppState.getState().setBackendError(undefined)
      }
      if (contextLimitError) setContextLimitError(null)
      if (hadBannerError) stripBannerMetadata()
      titleAbortRef.current?.abort()
      titleAbortRef.current = null

      ensureBranched()
      pendingAssistantParentId.current = resolveAssistantParent(messageId)

      regenerate(messageId ? { messageId } : undefined)
    },
    [
      regenerate,
      stripBannerMetadata,
      contextLimitError,
      ensureBranched,
      resolveAssistantParent,
    ]
  )

  // Editing forks a new sibling version (the original + its subtree are kept).
  // User edits regenerate a reply for the new branch; assistant edits don't.
  const handleEditMessage = useCallback(
    (messageId: string, newText: string) => {
      const msgs = ensureBranched()
      const target = msgs.find((m) => m.id === messageId)
      if (!target) return

      useMessageErrors.getState().clearError(messageId)
      titleAbortRef.current?.abort()
      titleAbortRef.current = null

      const newId = generateId()
      const sibling = makeSibling(target, {
        id: newId,
        createdAt: Date.now(),
        text: newText,
      })
      addMessage(sibling)
      setActiveBranch(sibling)

      if (target.role === 'user') {
        pendingAssistantParentId.current = newId
        syncActivePath()
        regenerate({ messageId: newId })
      } else {
        syncActivePath()
      }
    },
    [
      ensureBranched,
      addMessage,
      setActiveBranch,
      syncActivePath,
      regenerate,
    ]
  )

  const handleUserStop = useCallback(() => {
    userStopRequestedRef.current = true
    stop()
  }, [stop])

  // Handle delete message
  const handleDeleteMessage = useCallback(
    (messageId: string) => {
      deleteMessage(threadId, messageId)
      useMessageErrors.getState().clearError(messageId)

      // Update chat messages for UI
      const updatedChatMessages = chatMessages.filter(
        (msg) => msg.id !== messageId
      )
      setChatMessages(updatedChatMessages)
    },
    [threadId, deleteMessage, chatMessages, setChatMessages]
  )

  // Handler for increasing context size
  const handleContextSizeIncrease = useCallback(async () => {
    if (!selectedModel) return

    const updateProvider = useModelProvider.getState().updateProvider
    const provider = getProviderByName(selectedProvider)
    if (!provider) return

    const modelIndex = provider.models.findIndex(
      (m) => m.id === selectedModel.id
    )
    if (modelIndex === -1) return

    const model = provider.models[modelIndex]

    // Increase context length in steps: <8192 -> 8192 -> 32768 -> x1.5
    const currentCtxLen =
      (model.settings?.ctx_len?.controller_props?.value as number) ?? 8192
    const maxCtxLen =
      (model.settings?.ctx_len?.controller_props?.max as number) || 131072

    let newCtxLen: number
    if (currentCtxLen < 8192) {
      newCtxLen = 8192
    } else if (currentCtxLen < 32768) {
      newCtxLen = 32768
    } else {
      newCtxLen = Math.round(currentCtxLen * 1.5)
    }

    newCtxLen = Math.min(newCtxLen, maxCtxLen)
    if (newCtxLen <= currentCtxLen) {
      stampContextErrorOnThread(threadId)
      setContextLimitError(new Error(OUT_OF_CONTEXT_SIZE))
      return
    }

    const updatedModel = {
      ...model,
      settings: {
        ...model.settings,
        ctx_len: {
          ...(model.settings?.ctx_len ?? {}),
          controller_props: {
            ...(model.settings?.ctx_len?.controller_props ?? {}),
            value: newCtxLen,
          },
        },
      },
    }

    const updatedModels = [...provider.models]
    updatedModels[modelIndex] = updatedModel as Model

    updateProvider(provider.provider, {
      models: updatedModels,
    })

    // For llamacpp the router reads ctx-size from the preset, not from any
    // request param — so we must write model.yml and bounce the router before
    // the regenerate, otherwise the next load picks up the OLD context size.
    // Other providers consume the new Zustand value directly on next load.
    if (provider.provider === 'llamacpp') {
      try {
        await serviceHub
          .models()
          .updateModelSettings(selectedModel.id, { ctx_len: newCtxLen })
      } catch (e) {
        updateProvider(provider.provider, {
          models: provider.models,
        })
        console.error('Failed to persist increased ctx_len', e)
        stampContextErrorOnThread(threadId)
        setContextLimitError(new Error(OUT_OF_CONTEXT_SIZE))
        return
      }
    } else {
      await serviceHub.models().stopModel(selectedModel.id)
    }

    // Consume any pending partial captured at the `finishReason === 'length'`
    // event so the regenerate resumes from where the stream stopped, and the
    // "Growing the Mind…" shimmer renders while the model reloads.
    const pending = pendingContinuationRef.current
    pendingContinuationRef.current = null
    if (pending) {
      setContinueFromContentRef.current?.(pending.text)
      setPendingContinueMessage(pending.message)
    }

    setTimeout(() => {
      handleRegenerate()
    }, 1000)
  }, [
    selectedModel,
    selectedProvider,
    getProviderByName,
    serviceHub,
    handleRegenerate,
    threadId,
  ])

  // Keep refs in sync so onFinish always calls the latest versions
  handleContextSizeIncreaseRef.current = handleContextSizeIncrease
  setContinueFromContentRef.current = setContinueFromContent

  useEffect(() => {
    if (
      (oomError || backendError || contextLimitError) &&
      (status === 'streaming' || status === 'submitted')
    ) {
      try {
        stop()
      } catch (e) {
        console.warn('router error stop() threw:', e)
      }
    }
  }, [oomError, backendError, contextLimitError, status, stop])

  useEffect(() => {
    if (status === 'streaming' && pendingContinuationRef.current) {
      // The new turn is now flowing; drop the saved partial so it can't be
      // consumed by a later, unrelated "Increase Context Size" click.
      pendingContinuationRef.current = null
    }
    if (status === 'error' && pendingContinueMessage) {
      setPendingContinueMessage(null)
    }
  }, [status]) // eslint-disable-line react-hooks/exhaustive-deps

  // Message queue: claim the FIFO head, run it through the same normal send
  // path, then acknowledge only after the AI SDK accepts the submission.
  // Failed heads remain visible and block later entries until the user edits
  // or removes them, rather than spinning or silently changing branch.
  const processingQueueRef = useRef(false)
  const [queueWorkerEpoch, setQueueWorkerEpoch] = useState(0)

  useEffect(() => {
    if (status !== 'ready' || processingQueueRef.current) return
    if (sessionData.tools.length > 0) return

    const claim = useMessageQueue.getState().claimNext(threadId)
    if (!claim) return

    processingQueueRef.current = true
    let submissionAccepted = false
    const assertCanSubmit = () => {
      if (!useMessageQueue.getState().isDispatchable(threadId, claim)) {
        throw new QueuedSendCancelledError()
      }
    }
    processAndSendMessage(
      claim.message.text,
      undefined,
      {
        skillReferences: claim.message.skillReferences.map((reference) => ({
          ...reference,
          toolIds: [...reference.toolIds],
        })),
      },
      claim.message,
      assertCanSubmit,
      () => {
        submissionAccepted = true
        useMessageQueue.getState().acknowledge(threadId, claim)
      }
    )
      .then(() => {
        processingQueueRef.current = false
      })
      .catch((error) => {
        processingQueueRef.current = false
        if (error instanceof QueuedSendCancelledError) {
          useMessageQueue.getState().discard(threadId, claim)
          return
        }
        // After local handoff, late stream/runtime errors are durable chat
        // evidence. They must not restore a queue item or delete its user turn.
        if (submissionAccepted) return
        const branchParentMissing =
          error instanceof QueuedBranchParentMissingError
        useMessageQueue.getState().release(threadId, claim, {
          code: branchParentMissing
            ? 'branch_parent_missing'
            : 'submission_failed',
          message:
            error instanceof Error && error.message
              ? error.message
              : 'Queued message could not be submitted. Edit or remove it before retrying.',
        })
      })
      .finally(() => {
        processingQueueRef.current = false
        if (submissionAccepted) {
          setQueueWorkerEpoch((epoch) => epoch + 1)
        }
      })
  }, [
    status,
    threadId,
    processAndSendMessage,
    sessionData.tools.length,
    queuedMessages,
    queueWorkerEpoch,
  ])

  // Attach the error to the assistant turn it belongs to so the banner renders
  // alongside any tool-call parts the model already produced. Falls back to the
  // last user message if no assistant message exists yet (e.g. provider 4xx
  // before streaming starts).
  useEffect(() => {
    if (!error) return
    let targetId: string | undefined
    let lastUserIdx = -1
    for (let i = chatMessages.length - 1; i >= 0; i--) {
      if (chatMessages[i].role === 'user') {
        lastUserIdx = i
        break
      }
    }
    for (let i = chatMessages.length - 1; i > lastUserIdx; i--) {
      if (chatMessages[i].role === 'assistant') {
        targetId = chatMessages[i].id
        break
      }
    }
    if (!targetId && lastUserIdx >= 0) {
      targetId = chatMessages[lastUserIdx].id
    }
    if (!targetId) return
    const errMessage =
      error instanceof Error ? error.message : String(error || 'Error')
    // Context overflow is owned by the global "Increase Context Size" banner;
    // a per-message Regenerate would just re-overflow the same prompt.
    if (isContextOverflowMessage(errMessage)) {
      stampContextErrorOnThread(threadId, errMessage)
      setContextLimitError(new Error(errMessage))
      useMessageErrors.getState().clearError(targetId)
      return
    }
    useMessageErrors.getState().setError(targetId, errMessage)
    const tm = useMessages.getState().getMessages(threadId).find(
      (m) => m.id === targetId
    )
    if (tm) {
      const existingError = (tm.metadata as Record<string, unknown> | undefined)
        ?.error
      if (existingError !== errMessage) {
        updateMessage({
          ...tm,
          metadata: { ...(tm.metadata || {}), error: errMessage },
        })
      }
    }
  }, [status, error, threadId, chatMessages, updateMessage])

  // Persist whenever the user message lands in useMessages — covers the race
  // where the stamping effect ran before addMessage's commit was observable.
  const localThreadMessages = useMessages((s) => s.messages?.[threadId])
  const errorEntries = useMessageErrors((s) => s.errors)
  useEffect(() => {
    if (!localThreadMessages) return
    for (const m of localThreadMessages) {
      const err = errorEntries[m.id]
      if (typeof err !== 'string' || !err) continue
      const existing = (m.metadata as Record<string, unknown> | undefined)
        ?.error
      if (existing === err) continue
      updateMessage({
        ...m,
        metadata: { ...(m.metadata || {}), error: err },
      })
    }
  }, [localThreadMessages, errorEntries, updateMessage])

  const threadModel = useMemo(
    () => searchThreadModel ?? thread?.model,
    [searchThreadModel, thread]
  )

  // Per-message version counts for the `< n/m >` navigation control.
  const versionInfoById = useMemo(() => {
    const map: Record<string, { index: number; count: number }> = {}
    if (!localThreadMessages || !hasBranching(localThreadMessages)) return map
    for (const m of localThreadMessages) {
      const info = getVersionInfo(localThreadMessages, m)
      if (info.count > 1) map[m.id] = info
    }
    return map
  }, [localThreadMessages])

  return (
    <div className="flex flex-col h-[calc(100dvh-(env(safe-area-inset-bottom)+env(safe-area-inset-top)))]">
      <HeaderPage>
        {/* Codex titlebar structure: thread title anchored left, workspace
            control on the right. */}
        <div className="flex w-full items-center justify-between gap-3 pr-2">
          <span
            className="min-w-0 truncate text-sm font-medium"
            title={thread?.title}
          >
            {thread?.title
              ? readDivoTeachProfile(thread.metadata)
                ? teachThreadDisplayTitle(thread.title)
                : thread.title
              : 'New chat'}
          </span>
          <DivoWorkspaceSelector />
        </div>
      </HeaderPage>
      <div className="flex flex-1 flex-col h-full overflow-hidden">
        {/* Messages Area */}
        <div className="flex-1 relative">
          <Conversation className="absolute inset-0 text-start">
            <ConversationContent
              className={cn('mx-auto w-full md:w-[58%] xl:w-[48%]')}
            >
              {chatMessages.map((message, index) => {
                const isLastMessage = index === chatMessages.length - 1
                const isFirstMessage = index === 0
                // A banner error stands in for the failed assistant turn:
                // regenerate/reload restarts it from scratch, so hide the
                // partial (tool calls, "Worked for Ns") and show only the banner.
                if (
                  isLastMessage &&
                  hasBannerError &&
                  message.role === 'assistant'
                )
                  return null
                return (
                  <div key={message.id} data-message-id={message.id}>
                    <MessageItem
                      message={message}
                      isFirstMessage={isFirstMessage}
                      isLastMessage={isLastMessage}
                      status={effectiveStatus}
                      reasoningContainerRef={reasoningContainerRef}
                      isReasoningAtBottom={isReasoningAtBottom}
                      onReasoningScroll={handleReasoningScroll}
                      onReasoningScrollToBottom={forceScrollReasoningToBottom}
                      onRegenerate={handleRegenerate}
                      onEdit={handleEditMessage}
                      onDelete={handleDeleteMessage}
                      versionInfo={versionInfoById[message.id]}
                      onSwitchVersion={handleSwitchVersion}
                      isAnimating={!pendingContinueMessage}
                      hideActions={!!pendingContinueMessage}
                    />
                  </div>
                )
              })}
              {pendingContinueMessage && status === 'submitted' && (
                <MessageItem
                  key={`continue-placeholder-${pendingContinueMessage.id}`}
                  message={pendingContinueMessage}
                  isFirstMessage={false}
                  isLastMessage={true}
                  status={effectiveStatus}
                  reasoningContainerRef={reasoningContainerRef}
                  isReasoningAtBottom={isReasoningAtBottom}
                  onReasoningScroll={handleReasoningScroll}
                  onReasoningScrollToBottom={forceScrollReasoningToBottom}
                  onRegenerate={handleRegenerate}
                  onEdit={handleEditMessage}
                  onDelete={handleDeleteMessage}
                  hideActions
                  isAnimating={false}
                />
              )}
              {processingEmbeddings && (
                <div className="flex items-start gap-3 px-4 py-3 mx-4 my-2 rounded-lg border border-primary/20 bg-primary/5">
                  <IconLoader2 className="size-5 text-primary shrink-0 mt-0.5 animate-spin" />
                  <div className="flex-1">
                    <p className="text-sm font-medium text-main-view-fg mb-0.5">
                      {t('chat:embeddings.title')}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t('chat:embeddings.description')}
                    </p>
                  </div>
                </div>
              )}
              {!oomError &&
                !backendError &&
                !contextLimitError &&
                (status === CHAT_STATUS.SUBMITTED ||
                  status === CHAT_STATUS.STREAMING) && (
                <div className="flex flex-row items-center gap-2">
                  {pendingContinueMessage && (
                    <Shimmer duration={1}>Growing the Mind...</Shimmer>
                  )}
                  {!pendingContinueMessage &&
                    !lastAssistantHasVisibleActivity && (
                    <PromptProgress />
                  )}
                </div>
              )}
              {(contextLimitError || oomError || backendError) && (
                <div className="px-4 py-3 mx-4 my-2 rounded-lg border border-destructive/10 bg-destructive/10">
                  <div className="flex items-start gap-3">
                    <IconAlertCircle className="size-5 text-destructive shrink-0 mt-0.5" />
                    <div className="flex-1">
                      <p className="text-sm font-medium text-destructive mb-1">
                        {oomError
                          ? 'llama.cpp ran out of memory'
                          : backendError
                            ? 'GGML backend encountered an error'
                            : 'Model ran out of context size'}
                      </p>
                      <div className="table table-fixed w-full">
                        <span
                          className={
                            (oomError || backendError
                              ? 'text-xs font-mono'
                              : 'text-sm') +
                            ' text-muted-foreground table-cell align-middle'
                          }
                          style={{ wordWrap: 'break-word' }}
                        >
                          {oomError ?? backendError ?? contextBannerMessage}
                        </span>
                      </div>
                      {oomError && (
                        <ul className="mt-2 list-disc pl-5 text-xs text-muted-foreground space-y-0.5">
                          <li>Reduce context size (ctx-size)</li>
                          <li>Disable MTP (Multi-Token Prediction)</li>
                          <li>Lower n-gpu-layers or switch to a CPU backend</li>
                          <li>Use a smaller / more quantized model</li>
                        </ul>
                      )}
                      {((error ?? contextLimitError)?.message
                        ?.toLowerCase()
                        .includes('context') &&
                        ((error ?? contextLimitError)?.message
                          ?.toLowerCase()
                          .includes('size') ||
                          (error ?? contextLimitError)?.message
                            ?.toLowerCase()
                            .includes('length') ||
                          (error ?? contextLimitError)?.message
                            ?.toLowerCase()
                            .includes('limit'))) ||
                      (error ?? contextLimitError)?.message ===
                        OUT_OF_CONTEXT_SIZE ? (
                        <Button
                          variant="outline"
                          size="sm"
                          className="mt-3"
                          onClick={handleContextSizeIncrease}
                        >
                          <IconAlertCircle className="size-4 mr-2" />
                          Increase Context Size
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          className="mt-3"
                          onClick={() => handleRegenerate()}
                        >
                          <IconRefresh className="size-4 mr-2" />
                          {oomError || backendError ? 'Reload' : 'Regenerate'}
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              )}
              <ConversationPinSpacer pinId={pinId} nonce={pinNonce} />
            </ConversationContent>
            <ConversationScrollButton />
          </Conversation>
        </div>

        {/* Chat Input - Fixed at bottom */}
        <div className="py-4 mx-auto w-full md:w-[58%] xl:w-[48%]">
          <ChatInput
            threadId={threadId}
            model={threadModel}
            onSubmit={handleSubmit}
            onStop={handleUserStop}
            chatStatus={effectiveStatus}
          />
        </div>
      </div>
    </div>
  )
}
