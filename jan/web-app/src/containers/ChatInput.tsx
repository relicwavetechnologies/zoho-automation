import TextareaAutosize from 'react-textarea-autosize'
import { invoke } from '@tauri-apps/api/core'
import { cn, formatBytes } from '@/lib/utils'
import { usePrompt } from '@/hooks/usePrompt'
import { useThreads } from '@/hooks/useThreads'
import { useCallback, useEffect, useMemo, useRef, useState, memo } from 'react'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ArrowUp, GitBranch, Laptop, LoaderCircle, PlusIcon } from 'lucide-react'
import {
  IconPhoto,
  IconMusic,
  IconVideo,
  IconBrain,
  IconCodeCircle2,
  IconPlayerStopFilled,
  IconX,
  IconPaperclip,
  IconLoader2,
  IconWorld,
  IconBrandChrome,
} from '@tabler/icons-react'
import { generateId } from 'ai'
import { useMessageQueue } from '@/stores/message-queue-store'
import { QueuedMessageChip } from '@/containers/QueuedMessageBubble'
import { computeActivePath, hasBranching } from '@/lib/message-branching'
import { DivoModelToggle } from '@/containers/DivoModelToggle'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useReconcileVideoCapability } from '@/hooks/useReconcileVideoCapability'

import { useAppState } from '@/hooks/useAppState'
import { DivoComposerShell } from './composer/DivoComposerShell'
import type { ChatStatus } from 'ai'
import { useRouter } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import {
  TEMPORARY_CHAT_ID,
  TEMPORARY_CHAT_QUERY_ID,
  SESSION_STORAGE_KEY,
  SESSION_STORAGE_PREFIX,
} from '@/constants/chat'
import { useAssistant } from '@/hooks/useAssistant'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTools } from '@/hooks/useTools'
import { TokenCounter } from '@/components/TokenCounter'
import { useMessages } from '@/hooks/useMessages'
import { useShallow } from 'zustand/react/shallow'
import {
  ExtensionTypeEnum,
  fs,
  VectorDBExtension,
} from '@janhq/core'
import { ExtensionManager } from '@/lib/extension'
import { useAttachments } from '@/hooks/useAttachments'
import { toast } from 'sonner'
import { isPlatformTauri } from '@/lib/platform/utils'
import { useAttachmentIngestionPrompt } from '@/hooks/useAttachmentIngestionPrompt'
import {
  NEW_THREAD_ATTACHMENT_KEY,
  useChatAttachments,
} from '@/hooks/useChatAttachments'

import {
  Attachment,
  createImageAttachment,
  createDocumentAttachment,
  createAudioAttachment,
  createVideoAttachment,
} from '@/types/attachment'
import JanBrowserExtensionDialog from '@/containers/dialogs/JanBrowserExtensionDialog'
import { useJanBrowserExtension } from '@/hooks/useJanBrowserExtension'
import { useAgentMode } from '@/hooks/useAgentMode'
import { DIVO_THREAD_MODEL, PI_PROVIDER_ID } from '@/lib/pi'
import {
  SkillReferenceChips,
  SkillReferenceDrawer,
} from './SkillReferenceDrawer'
import {
  searchDivoSkills,
  type DivoSkillSearchResult,
} from '@/lib/divo-skill-search'
import {
  normalizeDivoSkillReferences,
  type DivoSkillReferenceSubmitOptions,
} from '@/lib/divo-skill-reference-context'
import { LiveApprovalComposer } from '@/components/approval-preview/LiveApprovalComposer'
import { usePiApproval } from '@/hooks/usePiApproval'
import type { PiApprovalRequest } from '@/lib/pi/approval'
import type { DivoQuickStartPlan } from '@/lib/divo-finance-quick-start'
import { RotatingPlaceholder } from '@/containers/RotatingPlaceholder'
import { TodoBubble } from '@/components/pi/TodoBubble'
import { ArtifactOpener } from '@/components/pi/ArtifactOpener'
import { ArtifactFileRefresh } from '@/components/pi/ArtifactFileRefresh'

type ChatInputProps = {
  className?: string
  /**
   * The authoritative route owner for all thread-scoped composer state.
   * Omit only on home/project composers, which intentionally follow the
   * current-thread store while no concrete route thread exists.
   */
  threadId?: string
  showSpeedToken?: boolean
  model?: ThreadModel
  initialMessage?: boolean
  projectId?: string
  onSubmit?: (
    text: string,
    files?: Array<{ type: string; mediaType: string; url: string }>,
    options?: DivoSkillReferenceSubmitOptions
  ) => void
  onStop?: () => void
  chatStatus?: ChatStatus
}

type TauriDragDropPayload = {
  paths?: string[]
}

type NormalizedImageAttachment = {
  path: string
  fileName: string
  mimeType: string
  size: number
  normalized: boolean
}

const EMPTY_PI_APPROVAL_QUEUE: PiApprovalRequest[] = []

const SHARE_MEMORY_COMMAND = '/share-memory'
const SHARE_MEMORY_COMMAND_REQUEST =
  'Help me share something with my team or company memory. Ask me what should be saved and where it should be shared.'

const matchesShareMemoryCommand = (search: string) => {
  const normalizedSearch = search.trim().toLowerCase().replace(/^\//, '')
  return (
    normalizedSearch.length === 0 ||
    'share-memory'.startsWith(normalizedSearch)
  )
}

const getFileNameFromPath = (path: string, fallback: string) =>
  path.split(/[\\/]/).filter(Boolean).pop() || fallback

const getFileExtension = (nameOrPath: string) =>
  getFileNameFromPath(nameOrPath, nameOrPath).toLowerCase().split('.').pop()

const IMAGE_EXTS = [
  'jpg',
  'jpeg',
  'png',
  'webp',
  'gif',
  'bmp',
  'tif',
  'tiff',
  'heic',
  'heif',
]
const AUDIO_EXTS = ['wav', 'mp3']
// Video containers llama-server can decode via ffmpeg/ffprobe into frames.
const VIDEO_EXTS = ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v']
const DOCUMENT_EXTS = [
  'pdf',
  'docx',
  'txt',
  'md',
  'csv',
  'xlsx',
  'xls',
  'ods',
  'pptx',
  'html',
  'htm',
  'js',
  'mjs',
  'cjs',
  'ts',
  'mts',
  'cts',
  'jsx',
  'tsx',
  'py',
  'pyw',
  'pyi',
  'c',
  'h',
  'cpp',
  'cc',
  'cxx',
  'hpp',
  'hh',
  'rs',
  'go',
  'swift',
  'zig',
  'java',
  'kt',
  'kts',
  'scala',
  'groovy',
  'rb',
  'php',
  'lua',
  'pl',
  'r',
  'jl',
  'cs',
  'fs',
  'vb',
  'xaml',
  'csproj',
  'sln',
  'cu',
  'cuh',
  'hlsl',
  'glsl',
  'cg',
  'shader',
  'sh',
  'bash',
  'zsh',
  'fish',
  'ps1',
  'bat',
  'cmd',
  'vbs',
  'asm',
  's',
  'm',
  'mm',
  'pas',
  'pp',
  'erl',
  'hrl',
  'ex',
  'exs',
  'clj',
  'cljs',
  'hs',
  'lhs',
  'ml',
  'mli',
  'f',
  'f90',
  'css',
  'scss',
  'sass',
  'less',
  'vue',
  'svelte',
  'astro',
  'asp',
  'aspx',
  'jsp',
  'json',
  'jsonc',
  'yaml',
  'yml',
  'toml',
  'xml',
  'ini',
  'cfg',
  'conf',
  'env',
  'properties',
  'dockerfile',
  'makefile',
  'cmake',
  'lock',
  'sql',
  'graphql',
  'gql',
  'tex',
  'rst',
  'adoc',
  'textile',
  'log',
  'diff',
  'patch',
  'gitignore',
]

const videoMimeForExt = (ext: string | undefined): string => {
  switch (ext) {
    case 'mov':
      return 'video/quicktime'
    case 'webm':
      return 'video/webm'
    case 'mkv':
      return 'video/x-matroska'
    case 'avi':
      return 'video/x-msvideo'
    default:
      return 'video/mp4'
  }
}

const isImageFileName = (name: string) => IMAGE_EXTS.includes(getFileExtension(name) ?? '')
const isAudioFileName = (name: string) => AUDIO_EXTS.includes(getFileExtension(name) ?? '')
const isVideoFileName = (name: string) => VIDEO_EXTS.includes(getFileExtension(name) ?? '')
const getDroppedFilePath = (file: File): string | undefined => {
  const maybePath = (file as File & { path?: unknown }).path
  return typeof maybePath === 'string' && maybePath.length > 0
    ? maybePath
    : undefined
}

const imageMimeForExt = (ext: string | undefined): string => {
  switch (ext) {
    case 'gif':
      return 'image/gif'
    case 'jpeg':
    case 'jpg':
      return 'image/jpeg'
    case 'png':
      return 'image/png'
    case 'webp':
      return 'image/webp'
    case 'bmp':
      return 'image/bmp'
    case 'tif':
    case 'tiff':
      return 'image/tiff'
    case 'heic':
      return 'image/heic'
    case 'heif':
      return 'image/heif'
    default:
      return ''
  }
}

const ChatInput = memo(function ChatInput({
  className,
  threadId,
  initialMessage,
  projectId,
  onSubmit,
  onStop,
  chatStatus,
}: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const skillReferenceSearchRequestRef = useRef(0)
  const [isFocused, setIsFocused] = useState(false)
  const [rows, setRows] = useState(1)
  const [skillReferenceDrawerOpen, setSkillReferenceDrawerOpen] =
    useState(false)
  const [skillReferenceSearch, setSkillReferenceSearch] = useState('')
  const [skillReferenceLoading, setSkillReferenceLoading] = useState(false)
  const [skillReferenceResults, setSkillReferenceResults] = useState<
    DivoSkillSearchResult[]
  >([])
  const [approvalQueueIndex, setApprovalQueueIndex] = useState(0)
  const [approvalClock, setApprovalClock] = useState(Date.now)
  const [selectedSkillReferences, setSelectedSkillReferences] = useState<
    DivoSkillSearchResult[]
  >([])
  const [skillReferenceError, setSkillReferenceError] = useState<string | null>(
    null
  )
  const serviceHub = useServiceHub()
  const abortControllers = useAppState((state) => state.abortControllers)
  const cancelToolCall = useAppState((state) => state.cancelToolCall)
  const prompt = usePrompt((state) => state.prompt)
  const setPrompt = usePrompt((state) => state.setPrompt)
  const addToHistory = usePrompt((state) => state.addToHistory)
  const navigateHistory = usePrompt((state) => state.navigateHistory)
  const currentThreadId = useThreads((state) => state.currentThreadId)
  // Route params commit before the passive effect that synchronizes the
  // global current-thread selection. A route owner must therefore take
  // precedence for every thread-scoped composer concern.
  const displayedThreadId = threadId ?? currentThreadId
  const currentThread = useThreads((state) =>
    displayedThreadId ? state.threads[displayedThreadId] : undefined
  )
  const activeBranchRootId =
    typeof (currentThread?.metadata as Record<string, unknown> | undefined)?.activeRootId === 'string'
      ? (currentThread?.metadata as Record<string, unknown>).activeRootId as string
      : undefined
  const isThreadBusy = useAppState((state) => {
    if (!displayedThreadId) return false
    return (
      displayedThreadId in state.busyThreads ||
      displayedThreadId in state.streamingContents ||
      displayedThreadId in state.loadingModels ||
      displayedThreadId in state.cancelToolCalls
    )
  })
  const activePiRunId = useAppState((state) =>
    displayedThreadId ? state.piThreadRunStates[displayedThreadId]?.runId : undefined
  )
  const approvalQueue = usePiApproval((state) =>
    displayedThreadId
      ? state.queues[displayedThreadId] ?? EMPTY_PI_APPROVAL_QUEUE
      : EMPTY_PI_APPROVAL_QUEUE
  )
  // Once the runtime has an exact owner, an approval from an older branch run
  // is never actionable or visible. Keep the queue intact for terminal-event
  // reconciliation; this is a presentation/action boundary, not authority.
  const visibleApprovalQueue = useMemo(
    () =>
      activePiRunId
        ? approvalQueue.filter((request) => request.runId === activePiRunId)
        : approvalQueue,
    [activePiRunId, approvalQueue]
  )
  const resolvePiApproval = usePiApproval((state) => state.resolve)
  const allowBashForChat = usePiApproval(
    (state) => state.allowBashForChat
  )
  const allowFullAccessForChat = usePiApproval(
    (state) => state.allowFullAccessForChat
  )
  const denyExpiredPiApprovals = usePiApproval((state) => state.denyExpired)
  const { t } = useTranslation()
  const spellCheckChatInput = useGeneralSetting(
    (state) => state.spellCheckChatInput
  )
  const tokenCounterCompact = useGeneralSetting(
    (state) => state.tokenCounterCompact
  )
  useTools()
  const router = useRouter()
  const createThread = useThreads((state) => state.createThread)
  const { 
    loading,
    currentAssistant,
    setCurrentAssistant,
    assistants
  } = useAssistant()

  // Agent mode
  // Use TEMPORARY_CHAT_ID as fallback key on the home screen (same pattern as attachments)
  const agentModeKey = displayedThreadId ?? TEMPORARY_CHAT_ID
  const isAgentMode = useAgentMode((state) =>
    state.agentThreads[agentModeKey] === true
  )
  // When projectId is present, treat as normal chat (disable agent mode UI)
  const effectiveAgentMode = isAgentMode && !projectId

  // Get current thread messages for token counting
  const threadMessages = useMessages(
    useShallow((state) =>
      displayedThreadId ? state.messages[displayedThreadId] : []
    )
  )

  const maxRows = 10
  const ATTACHMENT_AUTO_INLINE_FALLBACK_BYTES = 512 * 1024

  const selectedModel = useModelProvider((state) => state.selectedModel)
  const selectedProvider = useModelProvider((state) => state.selectedProvider)
  const isPiProvider = selectedProvider === PI_PROVIDER_ID
  const selectModelProvider = useModelProvider(
    (state) => state.selectModelProvider
  )
  const updateProvider = useModelProvider((state) => state.updateProvider)
  const [message, setMessage] = useState('')
  const [isDragOver, setIsDragOver] = useState(false)
  const [hasMmproj, setHasMmproj] = useState(false)
  const activeModels = useAppState(useShallow((state) => state.activeModels))
  // Check if selected model is currently loaded/active
  const isModelActive = selectedModel?.id ? activeModels.includes(selectedModel.id) : false

  // Reconcile video capability from /props once the model is loaded.
  useReconcileVideoCapability(selectedModel?.id, selectedProvider, isModelActive)
  const [selectedAssistantId, setSelectedAssistantId] = useState<
    string | undefined
  >(loading ? undefined : currentAssistant?.id || '')

  useEffect(() => {
    setSelectedAssistantId(currentAssistant?.id || '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading])

  useEffect(() => {
    // Route and run ownership changes must not retain an index from another
    // approval queue during a rapid navigation/branch transition.
    setApprovalQueueIndex(0)
  }, [displayedThreadId, activePiRunId])

  useEffect(() => {
    setApprovalQueueIndex((current) =>
      Math.min(current, Math.max(visibleApprovalQueue.length - 1, 0))
    )
    if (visibleApprovalQueue.length === 0) return

    setApprovalClock(Date.now())
    const timer = setInterval(() => {
      const now = Date.now()
      setApprovalClock(now)
      void denyExpiredPiApprovals(now)
    }, 30_000)
    return () => clearInterval(timer)
  }, [visibleApprovalQueue.length, denyExpiredPiApprovals])

  // Jan Browser Extension hook
  const {
    hasConfig: hasJanBrowserMCPConfig,
    isActive: janBrowserMCPActive,
    isLoading: isJanBrowserMCPLoading,
    dialogOpen: extensionDialogOpen,
    dialogState: extensionDialogState,
    toggleBrowser: handleBrowseClick,
    disableDueToIncompatibleModel,
    handleCancel: handleExtensionDialogCancel,
    setDialogOpen: setExtensionDialogOpen,
  } = useJanBrowserExtension()

  // Check if model supports browser feature (requires both vision and tools)
  const modelSupportsBrowser = useMemo(() => {
    const capabilities = selectedModel?.capabilities || []
    return capabilities.includes('vision') && capabilities.includes('tools')
  }, [selectedModel?.capabilities])

  // Auto-disable browser feature when model doesn't support it
  useEffect(() => {
    if (janBrowserMCPActive && !modelSupportsBrowser) {
      disableDueToIncompatibleModel()
    }
    // disableDueToIncompatibleModel omitted: its !isActive guard makes stale closures safe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [janBrowserMCPActive, modelSupportsBrowser])

  const attachmentsEnabled = useAttachments((s) => s.enabled)
  const parsePreference = useAttachments((s) => s.parseMode)
  const maxFileSizeMB = useAttachments((s) => s.maxFileSizeMB)

  // Derived: any document currently processing (ingestion in progress)
  const attachmentsKey = displayedThreadId ?? NEW_THREAD_ATTACHMENT_KEY
  const attachments = useChatAttachments(
    useCallback(
      (state) => state.getAttachments(attachmentsKey),
      [attachmentsKey]
    )
  )
  const setAttachmentsForThread = useChatAttachments(
    (state) => state.setAttachments
  )
  const transferAttachments = useChatAttachments(
    (state) => state.transferAttachments
  )
  const getProviderByName = useModelProvider((state) => state.getProviderByName)

  const ingestingDocs = attachments.some(
    (a) => a.type === 'document' && a.processing
  )
  const ingestingAny = attachments.some((a) => a.processing)
  const hasSendableMedia = attachments.some(
    (a) =>
      (a.type === 'image' || a.type === 'audio' || a.type === 'video') &&
      !!a.dataUrl
  )
  const hasSendableDocuments = attachments.some(
    (a) => a.type === 'document' && !!a.path
  )
  const hasSendableAttachments = hasSendableMedia || hasSendableDocuments

  const [, setFileIngestProgress] = useState<{
    completed: number
    total: number
  } | null>(null)

  // Queued messages for this thread (shown as chips in the input area)
  const queuedMessages = useMessageQueue(
    useShallow((s) => s.getQueue(displayedThreadId ?? ''))
  )
  const queueLength = queuedMessages.length

  const removeQueuedMessage = useCallback(
    (id: string) => {
      if (useMessageQueue.getState().requestCancellation(displayedThreadId ?? '', id)) {
        toast.info('Cancelling queued message before it is sent')
        return
      }
      useMessageQueue.getState().removeMessage(displayedThreadId ?? '', id)
    },
    [displayedThreadId]
  )

  const lastTransferredThreadId = useRef<string | null>(null)

  useEffect(() => {
    if (
      displayedThreadId &&
      lastTransferredThreadId.current !== displayedThreadId
    ) {
      transferAttachments(NEW_THREAD_ATTACHMENT_KEY, displayedThreadId)
      lastTransferredThreadId.current = displayedThreadId
    }
  }, [displayedThreadId, transferAttachments])

  // Check for mmproj existence or vision capability when model changes
  useEffect(() => {
    const checkMmprojSupport = async () => {
      if (selectedModel && selectedModel?.id) {
        try {
          // Only check mmproj for llamacpp provider
          if (selectedModel?.capabilities?.includes('vision')) {
            setHasMmproj(true)
          } else {
            setHasMmproj(false)
          }
        } catch (error) {
          console.error('Error checking mmproj:', error)
          setHasMmproj(false)
        }
      }
    }

    checkMmprojSupport()
  }, [selectedModel, selectedModel?.capabilities, selectedProvider, serviceHub])


  const handleSendMessage = async (
    prompt: string,
    quickStartPlan?: DivoQuickStartPlan
  ) => {
    const skillReferencesForSend = normalizeDivoSkillReferences(
      selectedSkillReferences
    )
    const submitOptions =
      skillReferencesForSend.length > 0 || quickStartPlan
        ? { skillReferences: skillReferencesForSend, quickStartPlan }
        : undefined

    if (!selectedModel) {
      setMessage('Please select a model to start chatting.')
      return
    }
    if (!prompt.trim() && !hasSendableAttachments) {
      return
    }
    if (ingestingAny) {
      toast.info('Please wait for attachments to finish processing')
      return
    }
    setMessage('')
    addToHistory(prompt)

    // Use onSubmit prop if available (AI SDK), otherwise create thread and navigate
    if (onSubmit) {
      // Keep one per-thread gate for streaming, post-stream tools, and Pi
      // approval waits; queued entries capture their complete send context.
      if ((isStreaming || isThreadBusy) && displayedThreadId) {
        const messagesAtQueueTime = threadMessages ?? []
        const activeRootId = (
          currentThread?.metadata as Record<string, unknown> | undefined
        )?.activeRootId as string | undefined
        const activePath = computeActivePath(messagesAtQueueTime, activeRootId)

        useMessageQueue.getState().enqueue(displayedThreadId, {
          id: generateId(),
          text: prompt,
          createdAt: Date.now(),
          skillReferences: skillReferencesForSend,
          attachments,
          parentId: activePath.at(-1)?.id ?? null,
          hadBranching: hasBranching(messagesAtQueueTime),
        })
        // Queued sends own a detached snapshot. Remove the composer-owned
        // attachments now so subsequent composer edits cannot alter replay.
        useChatAttachments.getState().clearAttachments(attachmentsKey)
        setPrompt('')
        setSelectedSkillReferences([])
        return
      }

      const imageFiles = attachments
        .filter((att) => att.type === 'image' && att.dataUrl)
        .map((att) => ({
          type: 'file',
          mediaType: att.mimeType ?? 'image/jpeg',
          url: att.dataUrl!,
        }))
      const audioFiles = attachments
        .filter((att) => att.type === 'audio' && att.dataUrl)
        .map((att) => ({
          type: 'file',
          mediaType: att.audioFormat === 'mp3' ? 'audio/mpeg' : 'audio/wav',
          url: att.dataUrl!,
        }))
      const videoFiles = attachments
        .filter((att) => att.type === 'video' && att.dataUrl)
        .map((att) => ({
          type: 'file',
          mediaType: att.mimeType ?? 'video/mp4',
          url: att.dataUrl!,
        }))
      const files = isPiProvider ? [] : [...imageFiles, ...audioFiles, ...videoFiles]

      if (submitOptions) {
        onSubmit(prompt, files.length > 0 ? files : undefined, submitOptions)
      } else {
        onSubmit(prompt, files.length > 0 ? files : undefined)
      }
      setPrompt('')
      setSelectedSkillReferences([])
      setAttachmentsForThread(attachmentsKey, (prev) =>
        isPiProvider
          ? prev
          : prev.filter((att) => att.type === 'document')
      )
    } else {
      // No onSubmit provided - create a new thread and navigate to it.
      // Media attachments (image/audio/video) are NOT serialized into
      // sessionStorage — their base64 data URLs blow past the ~5MB quota
      // (esp. video). They live in the in-memory attachments store and are
      // transferred to the new thread's key on the detail page (see the
      // transferAttachments effect); processAndSendMessage reads them there.
      const isTemporaryChat = window.location.search.includes(
        `${TEMPORARY_CHAT_QUERY_ID}=true`
      )

      const messagePayload = {
        text: prompt,
        files: [] as Array<{ type: string; mediaType: string; url: string }>,
        skillReferences: skillReferencesForSend,
        quickStartPlan,
      }

      if (isTemporaryChat) {
        // For temporary chat, store message and navigate to temporary thread
        sessionStorage.setItem(
          SESSION_STORAGE_KEY.INITIAL_MESSAGE_TEMPORARY,
          JSON.stringify(messagePayload)
        )
        sessionStorage.setItem('temp-chat-nav', 'true')
        // Transfer agent mode from home screen to temporary thread
        if (isAgentMode && agentModeKey !== TEMPORARY_CHAT_ID) {
          useAgentMode.getState().setAgentMode(TEMPORARY_CHAT_ID, true)
          useAgentMode.getState().removeThread(agentModeKey)
        }
        router.navigate({
          to: route.threadsDetail,
          params: { threadId: TEMPORARY_CHAT_ID },
        })
      } else {
        // Get project metadata and assistant if projectId is provided
        let projectMetadata:
          | { id: string; name: string; updated_at: number }
          | undefined
        let projectAssistantId: string | undefined

        if (projectId) {
          try {
            const project = await serviceHub
              .projects()
              .getProjectById(projectId)
            if (project) {
              projectMetadata = {
                id: project.id,
                name: project.name,
                updated_at: project.updated_at,
              }
              projectAssistantId = project.assistantId
            }
          } catch (e) {
            console.warn('Failed to fetch project metadata:', e)
          }
        }

        // Only use assistant when chatting via project with an assigned assistant
        // When no projectId, use the selected assistant from dropdown (if any)
        const assistant = projectAssistantId
          ? assistants.find((a) => a.id === projectAssistantId)
          : assistants.find((a) => a.id === selectedAssistantId)

        setCurrentAssistant(assistant)

        const newThread = await createThread(
          { ...DIVO_THREAD_MODEL },
          undefined,
          assistant,
          projectMetadata
        )

        // Transfer agent mode from home screen to the new thread
        if (isAgentMode) {
          useAgentMode.getState().setAgentMode(newThread.id, true)
          useAgentMode.getState().removeThread(agentModeKey)
        }

        // Store the initial message for the new thread
        sessionStorage.setItem(
          `${SESSION_STORAGE_PREFIX.INITIAL_MESSAGE}${newThread.id}`,
          JSON.stringify(messagePayload)
        )

        router.navigate({
          to: route.threadsDetail,
          params: { threadId: newThread.id },
        })
      }

      setPrompt('')
      setSelectedSkillReferences([])
      // Don't clear attachments here — document attachments stored under
      // NEW_THREAD_ATTACHMENT_KEY need to survive until the thread detail
      // page transfers and processes them.  The thread detail page's
      // processAndSendMessage already calls clearAttachmentsForThread after
      // processing is complete.
    }
  }

  const activateShareMemoryCommand = () => {
    setSkillReferenceDrawerOpen(false)
    setSkillReferenceSearch('')
    setSkillReferenceError(null)
    setSkillReferenceResults([])
    setPrompt('')
    void handleSendMessage(SHARE_MEMORY_COMMAND_REQUEST)
  }

  useEffect(() => {
    const handleFocusIn = () => {
      if (document.activeElement === textareaRef.current) {
        setIsFocused(true)
      }
    }

    const handleFocusOut = () => {
      if (document.activeElement !== textareaRef.current) {
        setIsFocused(false)
      }
    }

    document.addEventListener('focusin', handleFocusIn)
    document.addEventListener('focusout', handleFocusOut)

    return () => {
      document.removeEventListener('focusin', handleFocusIn)
      document.removeEventListener('focusout', handleFocusOut)
    }
  }, [])

  // NOTE: opening the `/` menu deliberately does NOT move focus. The query is
  // the text already being typed in the composer, so pulling focus into the
  // menu interrupted the user mid-word and left them typing in a second box.

  useEffect(() => {
    if (!skillReferenceDrawerOpen) {
      return
    }

    const query = skillReferenceSearch.trim()
    if (!query) {
      skillReferenceSearchRequestRef.current += 1
      setSkillReferenceLoading(false)
      setSkillReferenceError(null)
      setSkillReferenceResults([])
      return
    }

    setSkillReferenceLoading(true)
    setSkillReferenceError(null)
    const requestId = skillReferenceSearchRequestRef.current + 1
    skillReferenceSearchRequestRef.current = requestId

    const timeout = window.setTimeout(() => {
      searchDivoSkills(query, 5)
        .then((results) => {
          if (skillReferenceSearchRequestRef.current !== requestId) return
          setSkillReferenceResults(results)
          setSkillReferenceLoading(false)
        })
        .catch((error) => {
          if (skillReferenceSearchRequestRef.current !== requestId) return
          setSkillReferenceResults([])
          setSkillReferenceError(
            error instanceof Error ? error.message : String(error)
          )
          setSkillReferenceLoading(false)
        })
    }, 180)

    return () => window.clearTimeout(timeout)
  }, [skillReferenceDrawerOpen, skillReferenceSearch])

  // Focus when component mounts
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.focus()
    }
  }, [])

  // Focus when thread changes
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.focus()
    }
  }, [displayedThreadId])

  // Focus when streaming content finishes
  useEffect(() => {
    if (chatStatus !== 'submitted' && textareaRef.current) {
      // Small delay to ensure UI has updated
      setTimeout(() => {
        textareaRef.current?.focus()
      }, 10)
    }
  }, [chatStatus])

  const stopStreaming = useCallback(
    (threadId: string) => {
      // Use onStop prop if available (AI SDK), otherwise use legacy abort
      if (onStop) {
        onStop()
      } else {
        abortControllers[threadId]?.abort()
      }
      // Pi carries cancellation in the owning thread/run transport. Calling
      // the legacy global callback here could cancel a different concurrent
      // chat, so retain it only for non-Pi providers.
      if (!isPiProvider) cancelToolCall?.()
      // Escalate: if the llama.cpp model is still processing after the HTTP
      // abort, force-unload it so generation actually stops. KV cache is lost.
      const modelId = selectedModel?.id
      if (selectedProvider === 'llamacpp' && modelId) {
        setTimeout(() => {
          invoke('plugin:llamacpp|force_stop_model', { modelId }).catch((e) => {
            console.warn('force_stop_model failed:', e)
          })
        }, 500)
      }
    },
    [abortControllers, cancelToolCall, isPiProvider, onStop, selectedModel?.id, selectedProvider]
  )

  const fileInputRef = useRef<HTMLInputElement>(null)
  const audioInputRef = useRef<HTMLInputElement>(null)
  const audioSupported = !!selectedModel?.capabilities?.includes('audio')
  const videoInputRef = useRef<HTMLInputElement>(null)
  const videoSupported = !!selectedModel?.capabilities?.includes('video')
  const imageAttachmentsSupported = hasMmproj || isPiProvider

  const processNewDocumentAttachments = useCallback(
    async (docs: Attachment[]) => {
      if (!docs.length) return
      if (isPiProvider) return

      // Only collect the user's inline-vs-embeddings preference via the
      // dialog.  Actual ingestion is always deferred to send time
      // (processAttachmentsForSend inside processAndSendMessage).
      const docsNeedingPrompt = docs.filter((doc) => {
        if (doc.processed || doc.injectionMode) return false
        const preference = doc.parseMode ?? parsePreference
        return preference === 'prompt' || preference === 'auto'
      })

      if (docsNeedingPrompt.length > 0) {
        const choices = new Map<string, 'inline' | 'embeddings'>()
        for (let i = 0; i < docsNeedingPrompt.length; i++) {
          const doc = docsNeedingPrompt[i]
          const choice = await useAttachmentIngestionPrompt
            .getState()
            .showPrompt(
              doc,
              ATTACHMENT_AUTO_INLINE_FALLBACK_BYTES,
              i,
              docsNeedingPrompt.length
            )

          if (!choice) {
            // User cancelled — remove all pending docs
            setAttachmentsForThread(attachmentsKey, (prev) =>
              prev.filter(
                (att) =>
                  !docsNeedingPrompt.some(
                    (d) => d.path && att.path && d.path === att.path
                  )
              )
            )
            return
          }

          if (doc.path) {
            choices.set(doc.path, choice)
          }
        }

        // Persist each document's chosen mode so processAttachmentsForSend
        // can pick it up at send time.
        if (choices.size > 0) {
          setAttachmentsForThread(attachmentsKey, (prev) =>
            prev.map((att) => {
              const mode = att.path ? choices.get(att.path) : undefined
              return mode ? { ...att, parseMode: mode } : att
            })
          )
        }
      }
    },
    [
      ATTACHMENT_AUTO_INLINE_FALLBACK_BYTES,
      attachmentsKey,
      isPiProvider,
      parsePreference,
      setAttachmentsForThread,
    ]
  )

  const attachDocumentPaths = useCallback(
    async (paths: string[]) => {
      if (!paths.length) return
      if (!attachmentsEnabled) {
        toast.info('Attachments are disabled in Settings')
        return
      }

      const preparedAttachments: Attachment[] = []
      for (const path of paths) {
        const name = getFileNameFromPath(path, path)
        const fileType = getFileExtension(name)
        let size: number | undefined
        try {
          const stat = await fs.fileStat(path)
          size = stat?.size ? Number(stat.size) : undefined
        } catch (error) {
          console.warn('Failed to read file size for', path, error)
        }
        preparedAttachments.push(
          createDocumentAttachment({
            name,
            path,
            fileType,
            size,
            parseMode: isPiProvider ? 'prompt' : parsePreference,
          })
        )
      }

      const maxFileSizeBytes =
        typeof maxFileSizeMB === 'number' && maxFileSizeMB > 0
          ? maxFileSizeMB * 1024 * 1024
          : undefined

      if (maxFileSizeBytes !== undefined) {
        const oversized = preparedAttachments.filter(
          (att) => typeof att.size === 'number' && att.size > maxFileSizeBytes
        )
        if (oversized.length > 0) {
          toast.error('File too large', {
            description: `One or more files exceed the ${maxFileSizeMB}MB limit`,
          })
          return
        }
      }

      let duplicates: string[] = []
      let newDocAttachments: Attachment[] = []

      setAttachmentsForThread(attachmentsKey, (currentAttachments) => {
        const existingPaths = new Set(
          currentAttachments
            .filter((a) => a.type === 'document' && a.path)
            .map((a) => a.path)
        )

        duplicates = []
        newDocAttachments = []

        for (const att of preparedAttachments) {
          if (att.path && existingPaths.has(att.path)) {
            duplicates.push(att.name)
            continue
          }
          newDocAttachments.push(att)
        }

        return newDocAttachments.length > 0
          ? [...currentAttachments, ...newDocAttachments]
          : currentAttachments
      })

      if (duplicates.length > 0) {
        toast.warning('Files already attached', {
          description: `${duplicates.join(', ')} ${duplicates.length === 1 ? 'is' : 'are'} already in the list`,
        })
      }

      if (newDocAttachments.length > 0) {
        await processNewDocumentAttachments(newDocAttachments)
      }
    },
    [
      attachmentsEnabled,
      attachmentsKey,
      isPiProvider,
      maxFileSizeMB,
      parsePreference,
      processNewDocumentAttachments,
      setAttachmentsForThread,
    ]
  )

  const handleAttachDocsIngest = async () => {
    try {
      const selection = await serviceHub.dialog().open({
        multiple: true,
        filters: [
          {
            name: 'Documents & Code',
            extensions: DOCUMENT_EXTS,
          },
          {
            name: 'All Files',
            extensions: ['*'],
          },
        ],
      })
      if (!selection) return
      const paths = Array.isArray(selection) ? selection : [selection]
      if (!paths.length) return
      await attachDocumentPaths(paths)
    } catch (e) {
      console.error('Failed to attach documents:', e)
      const desc = e instanceof Error ? e.message : JSON.stringify(e)
      toast.error('Failed to attach documents', { description: desc })
    }
  }

  const handleRemoveAttachment = async (indexToRemove: number) => {
    const attachmentToRemove = attachments[indexToRemove]

    // If attachment was ingested (has an ID), delete it from the backend
    if (attachmentToRemove?.id && displayedThreadId) {
      try {
        if (attachmentToRemove.type === 'document') {
          const vectorDBExtension = ExtensionManager.getInstance().get(
            ExtensionTypeEnum.VectorDB
          ) as VectorDBExtension | undefined

          if (vectorDBExtension?.deleteFile) {
            await vectorDBExtension.deleteFile(
              displayedThreadId,
              attachmentToRemove.id
            )
          }
        }
      } catch (error) {
        console.error('Failed to delete attachment from backend:', error)
        toast.error('Failed to remove attachment', {
          description: error instanceof Error ? error.message : String(error),
        })
        return
      }
    }

    setAttachmentsForThread(attachmentsKey, (prev) =>
      prev.filter((_, index) => index !== indexToRemove)
    )
  }

  const getFileTypeFromExtension = (fileName: string): string => {
    return imageMimeForExt(getFileExtension(fileName))
  }

  const hashBase64 = async (base64: string): Promise<string> => {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    const hashBuffer = await crypto.subtle.digest('SHA-256', bytes)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
  }

  const readImageDataUrl = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        const result = reader.result
        if (typeof result === 'string') {
          resolve(result)
        } else {
          reject(new Error('Failed to read image as data URL'))
        }
      }
      reader.onerror = () =>
        reject(reader.error ?? new Error('Failed to read image as data URL'))
      reader.readAsDataURL(file)
    })

  const normalizeImageForOcr = useCallback(
    async (
      file: File,
      dataUrl: string,
      fallbackMimeType: string
    ): Promise<NormalizedImageAttachment | null> => {
      if (!isPlatformTauri()) return null

      return invoke<NormalizedImageAttachment>('divo_normalize_image_attachment', {
        sourcePath: getDroppedFilePath(file) ?? null,
        dataUrl,
        fileName: file.name,
        mimeType: fallbackMimeType || file.type || null,
      })
    },
    []
  )

  const processImageFiles = useCallback(async (files: File[]) => {
    const maxSize = 10 * 1024 * 1024 // 10MB in bytes
    const oversizedFiles: string[] = []
    const invalidTypeFiles: string[] = []
    const normalizationErrors: string[] = []

    const validFiles: File[] = []

    // First pass: validate file size and type (no duplicate check yet)
    Array.from(files).forEach((file) => {
      // Check file size
      if (file.size > maxSize) {
        oversizedFiles.push(file.name)
        return
      }

      // Get file type - use extension as fallback if MIME type is incorrect
      const detectedType = file.type || getFileTypeFromExtension(file.name)
      const actualType = getFileTypeFromExtension(file.name) || detectedType

      // Check file type - images only
      if (!actualType.startsWith('image/')) {
        invalidTypeFiles.push(file.name)
        return
      }

      validFiles.push(file)
    })

    // Process valid files into attachments
    const preparedFiles: Attachment[] = []
    for (const file of validFiles) {
      const detectedType = file.type || getFileTypeFromExtension(file.name)
      const actualType = getFileTypeFromExtension(file.name) || detectedType

      const result = await readImageDataUrl(file)
      const base64String = result.split(',')[1] ?? ''
      let normalized: NormalizedImageAttachment | null = null
      try {
        normalized = await normalizeImageForOcr(file, result, actualType)
      } catch (error) {
        console.error('Failed to normalize image for OCR:', error)
        normalizationErrors.push(
          `${file.name}: ${error instanceof Error ? error.message : String(error)}`
        )
        continue
      }

      const att = createImageAttachment({
        name: file.name,
        size: normalized?.size ?? file.size,
        mimeType: normalized?.mimeType ?? actualType,
        base64: base64String,
        dataUrl: result,
        path: normalized?.path ?? getDroppedFilePath(file),
      })
      preparedFiles.push(att)
    }

    // Compute content hashes for deduplication (allows different images with same filename)
    for (const att of preparedFiles) {
      if (att.base64) {
        att.contentHash = await hashBase64(att.base64)
      }
    }

    const duplicates: string[] = []
    const newFiles: Attachment[] = []

    const currentAttachments = useChatAttachments.getState().getAttachments(
      attachmentsKey
    )

    const existingImageHashes = new Set<string>()
    const existingImageNames = new Set<string>()
    for (const a of currentAttachments) {
      if (a.type !== 'image') continue
      if (a.contentHash) {
        existingImageHashes.add(a.contentHash)
      } else if (a.base64) {
        existingImageHashes.add(await hashBase64(a.base64))
      } else {
        existingImageNames.add(a.name)
      }
    }

    const seenHashesInBatch = new Set<string>()
    for (const att of preparedFiles) {
      const hash = att.contentHash
      const isDuplicateByContent =
        hash &&
        (existingImageHashes.has(hash) || seenHashesInBatch.has(hash))
      const isDuplicateByName =
        existingImageNames.has(att.name)
      if (isDuplicateByContent || isDuplicateByName) {
        duplicates.push(att.name)
        continue
      }
      if (hash) {
        seenHashesInBatch.add(hash)
      }
      newFiles.push(att)
    }

    setAttachmentsForThread(attachmentsKey, (prev) =>
      newFiles.length > 0 ? [...prev, ...newFiles] : prev
    )

    if (displayedThreadId && newFiles.length > 0) {
      const ingestTotal = newFiles.length
      void (async () => {
        setFileIngestProgress({ completed: 0, total: ingestTotal })
        try {
          for (let i = 0; i < newFiles.length; i++) {
            const img = newFiles[i]
            const matchImg = (a: Attachment) =>
              a.type === 'image' &&
              (img.contentHash
                ? a.contentHash === img.contentHash
                : a.name === img.name)

            try {
              setAttachmentsForThread(attachmentsKey, (prev) =>
                prev.map((a) => (matchImg(a) ? { ...a, processing: true } : a))
              )

              const result = await serviceHub
                .uploads()
                .ingestImage(displayedThreadId, img)

              if (result?.id) {
                setAttachmentsForThread(attachmentsKey, (prev) =>
                  prev.map((a) =>
                    matchImg(a)
                      ? {
                          ...a,
                          processing: false,
                          processed: true,
                          id: result.id,
                        }
                      : a
                  )
                )
              } else {
                throw new Error('No ID returned from image ingestion')
              }
            } catch (error) {
              console.error('Failed to ingest image:', error)
              setAttachmentsForThread(attachmentsKey, (prev) =>
                prev.filter((a) => !matchImg(a))
              )
              toast.error(`Failed to ingest ${img.name}`, {
                description:
                  error instanceof Error ? error.message : String(error),
              })
            } finally {
              setFileIngestProgress({
                completed: i + 1,
                total: ingestTotal,
              })
            }
          }
        } finally {
          setFileIngestProgress(null)
        }
      })()
    }

    // Display validation errors
    if (duplicates.length > 0) {
      toast.warning('Some images already attached', {
        description: `${duplicates.join(', ')} ${duplicates.length === 1 ? 'is' : 'are'} already in the list`,
      })
    }

    const errors: string[] = []
    if (oversizedFiles.length > 0) {
      errors.push(
        `File${oversizedFiles.length > 1 ? 's' : ''} too large (max 10MB): ${oversizedFiles.join(', ')}`
      )
    }

    if (invalidTypeFiles.length > 0) {
      errors.push(
        `Invalid image type${invalidTypeFiles.length > 1 ? 's' : ''}: ${invalidTypeFiles.join(', ')}`
      )
    }

    if (normalizationErrors.length > 0) {
      errors.push(`Could not prepare image for OCR: ${normalizationErrors.join('; ')}`)
    }

    if (errors.length > 0) {
      setMessage(errors.join(' | '))
      // Reset file input to allow re-uploading
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    } else {
      setMessage('')
    }
  }, [
    attachmentsKey,
    displayedThreadId,
    normalizeImageForOcr,
    setAttachmentsForThread,
    serviceHub,
    setFileIngestProgress,
  ])

  const readFilesFromPaths = useCallback(
    async (
      paths: string[],
      options: {
        fallbackName: string
        getMimeType: (fileName: string) => string
        errorTitle: string
      }
    ) => {
      const files: File[] = []

      for (const path of paths) {
        try {
          const fileUrl = serviceHub.core().convertFileSrc(path)
          const response = await fetch(fileUrl)
          if (!response.ok) {
            throw new Error(`Failed to fetch file: ${response.statusText}`)
          }

          const blob = await response.blob()
          const fileName = getFileNameFromPath(path, options.fallbackName)
          const file = new File([blob], fileName, {
            type: options.getMimeType(fileName),
          })
          Object.defineProperty(file, 'path', {
            configurable: true,
            value: path,
          })
          files.push(file)
        } catch (error) {
          console.error(`${options.errorTitle}:`, error)
          toast.error(options.errorTitle, {
            description:
              error instanceof Error ? error.message : String(error),
          })
        }
      }

      return files
    },
    [serviceHub]
  )

  const readImageFilesFromPaths = useCallback(
    async (paths: string[]) =>
      readFilesFromPaths(paths, {
        fallbackName: 'image',
        getMimeType: (fileName) =>
          imageMimeForExt(fileName.toLowerCase().split('.').pop()),
        errorTitle: 'Failed to read image file',
      }),
    [readFilesFromPaths]
  )

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files

    if (files && files.length > 0) {
      void processImageFiles(Array.from(files))

      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }

    if (textareaRef.current) {
      textareaRef.current.focus()
    }
  }

  const decodeAudioDuration = (dataUrl: string): Promise<number | undefined> =>
    new Promise((resolve) => {
      try {
        const audio = new Audio()
        audio.preload = 'metadata'
        audio.onloadedmetadata = () => {
          const d = audio.duration
          resolve(Number.isFinite(d) && d > 0 ? d : undefined)
        }
        audio.onerror = () => resolve(undefined)
        audio.src = dataUrl
      } catch {
        resolve(undefined)
      }
    })

  const processAudioFiles = useCallback(
    async (files: File[]) => {
      const maxBytes = 25 * 1024 * 1024
      const oversized: string[] = []
      const invalid: string[] = []
      const prepared: Attachment[] = []

      for (const file of Array.from(files)) {
        const lower = file.name.toLowerCase()
        const ext = lower.split('.').pop()
        const isWav = file.type === 'audio/wav' || file.type === 'audio/x-wav' || ext === 'wav'
        const isMp3 = file.type === 'audio/mpeg' || file.type === 'audio/mp3' || ext === 'mp3'
        if (!isWav && !isMp3) {
          invalid.push(file.name)
          continue
        }
        if (file.size > maxBytes) {
          oversized.push(file.name)
          continue
        }
        const fmt: 'wav' | 'mp3' = isWav ? 'wav' : 'mp3'
        const mimeType = fmt === 'wav' ? 'audio/wav' : 'audio/mpeg'
        const dataUrl: string = await new Promise((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => {
            const r = reader.result
            if (typeof r === 'string') resolve(r)
            else reject(new Error('read failed'))
          }
          reader.onerror = () => reject(reader.error ?? new Error('read failed'))
          reader.readAsDataURL(file)
        })
        const base64 = dataUrl.split(',')[1] ?? ''
        const durationSec = await decodeAudioDuration(dataUrl)
        prepared.push(
          createAudioAttachment({
            name: file.name,
            base64,
            dataUrl,
            mimeType,
            audioFormat: fmt,
            size: file.size,
            durationSec,
          })
        )
      }

      const current = useChatAttachments.getState().getAttachments(attachmentsKey)
      const existingNames = new Set(
        current.filter((a) => a.type === 'audio').map((a) => a.name)
      )
      const duplicates: string[] = []
      const newOnes: Attachment[] = []
      for (const att of prepared) {
        if (existingNames.has(att.name)) {
          duplicates.push(att.name)
          continue
        }
        newOnes.push(att)
      }

      if (newOnes.length > 0) {
        setAttachmentsForThread(attachmentsKey, (prev) => [...prev, ...newOnes])
      }

      if (duplicates.length > 0) {
        toast.warning('Some audio files already attached', {
          description: `${duplicates.join(', ')} ${duplicates.length === 1 ? 'is' : 'are'} already in the list`,
        })
      }
      const errors: string[] = []
      if (oversized.length > 0) {
        errors.push(
          `Audio file${oversized.length > 1 ? 's' : ''} too large (max 25MB): ${oversized.join(', ')}`
        )
      }
      if (invalid.length > 0) {
        errors.push(
          `Invalid audio type${invalid.length > 1 ? 's' : ''} (only WAV, MP3 allowed): ${invalid.join(', ')}`
        )
      }
      if (errors.length > 0) {
        setMessage(errors.join(' | '))
        if (audioInputRef.current) audioInputRef.current.value = ''
      }
    },
    [attachmentsKey, setAttachmentsForThread]
  )

  const handleAudioFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (files && files.length > 0) {
      void processAudioFiles(Array.from(files))
      if (audioInputRef.current) audioInputRef.current.value = ''
    }
    if (textareaRef.current) textareaRef.current.focus()
  }

  const readAudioFilesFromPaths = useCallback(
    async (paths: string[]) =>
      readFilesFromPaths(paths, {
        fallbackName: 'audio',
        getMimeType: (fileName) => {
          const ext = fileName.toLowerCase().split('.').pop()
          return ext === 'mp3' ? 'audio/mpeg' : ext === 'wav' ? 'audio/wav' : ''
        },
        errorTitle: 'Failed to read audio file',
      }),
    [readFilesFromPaths]
  )

  const openAudioPicker = useCallback(async () => {
    if (isPlatformTauri()) {
      try {
        const selected = await serviceHub.dialog().open({
          multiple: true,
          filters: [{ name: 'Audio', extensions: ['wav', 'mp3'] }],
        })
        if (selected) {
          const paths = Array.isArray(selected) ? selected : [selected]
          const files = await readAudioFilesFromPaths(paths)
          if (files.length > 0) await processAudioFiles(files)
        }
      } catch (error) {
        console.error('Failed to open audio dialog:', error)
      }
      if (textareaRef.current) textareaRef.current.focus()
    } else {
      audioInputRef.current?.click()
    }
  }, [serviceHub, processAudioFiles, readAudioFilesFromPaths])

  const processVideoFiles = useCallback(
    async (files: File[]) => {
      const maxBytes = 100 * 1024 * 1024
      const oversized: string[] = []
      const invalid: string[] = []
      const prepared: Attachment[] = []

      for (const file of Array.from(files)) {
        const ext = file.name.toLowerCase().split('.').pop()
        const isVideo =
          file.type.startsWith('video/') || VIDEO_EXTS.includes(ext ?? '')
        if (!isVideo) {
          invalid.push(file.name)
          continue
        }
        if (file.size > maxBytes) {
          oversized.push(file.name)
          continue
        }
        const mimeType = file.type.startsWith('video/')
          ? file.type
          : videoMimeForExt(ext)
        const dataUrl: string = await new Promise((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => {
            const r = reader.result
            if (typeof r === 'string') resolve(r)
            else reject(new Error('read failed'))
          }
          reader.onerror = () => reject(reader.error ?? new Error('read failed'))
          reader.readAsDataURL(file)
        })
        const base64 = dataUrl.split(',')[1] ?? ''
        prepared.push(
          createVideoAttachment({
            name: file.name,
            base64,
            dataUrl,
            mimeType,
            size: file.size,
          })
        )
      }

      const current = useChatAttachments.getState().getAttachments(attachmentsKey)
      const existingNames = new Set(
        current.filter((a) => a.type === 'video').map((a) => a.name)
      )
      const duplicates: string[] = []
      const newOnes: Attachment[] = []
      for (const att of prepared) {
        if (existingNames.has(att.name)) {
          duplicates.push(att.name)
          continue
        }
        newOnes.push(att)
      }

      if (newOnes.length > 0) {
        setAttachmentsForThread(attachmentsKey, (prev) => [...prev, ...newOnes])
      }

      if (duplicates.length > 0) {
        toast.warning('Some video files already attached', {
          description: `${duplicates.join(', ')} ${duplicates.length === 1 ? 'is' : 'are'} already in the list`,
        })
      }
      const errors: string[] = []
      if (oversized.length > 0) {
        errors.push(
          `Video file${oversized.length > 1 ? 's' : ''} too large (max 100MB): ${oversized.join(', ')}`
        )
      }
      if (invalid.length > 0) {
        errors.push(
          `Invalid video type${invalid.length > 1 ? 's' : ''}: ${invalid.join(', ')}`
        )
      }
      if (errors.length > 0) {
        setMessage(errors.join(' | '))
        if (videoInputRef.current) videoInputRef.current.value = ''
      }
    },
    [attachmentsKey, setAttachmentsForThread]
  )

  const handleVideoFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (files && files.length > 0) {
      void processVideoFiles(Array.from(files))
      if (videoInputRef.current) videoInputRef.current.value = ''
    }
    if (textareaRef.current) textareaRef.current.focus()
  }

  const readVideoFilesFromPaths = useCallback(
    async (paths: string[]) =>
      readFilesFromPaths(paths, {
        fallbackName: 'video',
        getMimeType: (fileName) =>
          videoMimeForExt(fileName.toLowerCase().split('.').pop()),
        errorTitle: 'Failed to read video file',
      }),
    [readFilesFromPaths]
  )

  const openVideoPicker = useCallback(async () => {
    if (isPlatformTauri()) {
      try {
        const selected = await serviceHub.dialog().open({
          multiple: true,
          filters: [{ name: 'Video', extensions: VIDEO_EXTS }],
        })
        if (selected) {
          const paths = Array.isArray(selected) ? selected : [selected]
          const files = await readVideoFilesFromPaths(paths)
          if (files.length > 0) await processVideoFiles(files)
        }
      } catch (error) {
        console.error('Failed to open video dialog:', error)
      }
      if (textareaRef.current) textareaRef.current.focus()
    } else {
      videoInputRef.current?.click()
    }
  }, [serviceHub, processVideoFiles, readVideoFilesFromPaths])

  // Open the image picker dialog (extracted for reuse)
  const openImagePicker = useCallback(async () => {
    if (isPlatformTauri()) {
      try {
        const selected = await serviceHub.dialog().open({
          multiple: true,
          filters: [
            {
              name: 'Images',
              extensions: IMAGE_EXTS,
            },
          ],
        })

        if (selected) {
          const paths = Array.isArray(selected) ? selected : [selected]
          const files = await readImageFilesFromPaths(paths)
          if (files.length > 0) {
            await processImageFiles(files)
          }
        }
      } catch (error) {
        console.error('Failed to open file dialog:', error)
      }

      if (textareaRef.current) {
        textareaRef.current.focus()
      }
    } else {
      // Fallback to input click for web
      fileInputRef.current?.click()
    }
  }, [serviceHub, processImageFiles, readImageFilesFromPaths])

  const dropAcceptsAnything =
    attachmentsEnabled ||
    imageAttachmentsSupported ||
    audioSupported ||
    videoSupported

  useEffect(() => {
    if (!isPlatformTauri() || !dropAcceptsAnything) return

    let cancelled = false
    const unlisteners: Array<() => void> = []
    const addUnlistener = (unlisten: () => void) => {
      if (cancelled) {
        unlisten()
      } else {
        unlisteners.push(unlisten)
      }
    }

    serviceHub
      .events()
      .listen('tauri://drag-enter', () => {
        setIsDragOver(true)
      })
      .then(addUnlistener)

    serviceHub
      .events()
      .listen('tauri://drag-over', () => {
        setIsDragOver(true)
      })
      .then(addUnlistener)

    serviceHub
      .events()
      .listen('tauri://drag-leave', () => {
        setIsDragOver(false)
      })
      .then(addUnlistener)

    serviceHub
      .events()
      .listen<TauriDragDropPayload>('tauri://drag-drop', async (event) => {
        setIsDragOver(false)

        const paths = event.payload.paths ?? []
        if (paths.length === 0) return

        const audioPaths = audioSupported ? paths.filter(isAudioFileName) : []
        const videoPaths = videoSupported ? paths.filter(isVideoFileName) : []
        const imagePaths = imageAttachmentsSupported
          ? paths.filter(
              (path) =>
                isImageFileName(path) &&
                !audioPaths.includes(path) &&
                !videoPaths.includes(path)
            )
          : []
        const documentPaths = attachmentsEnabled
          ? paths.filter(
              (path) =>
                !audioPaths.includes(path) &&
                !videoPaths.includes(path) &&
                !imagePaths.includes(path)
            )
          : []

        if (documentPaths.length > 0) {
          await attachDocumentPaths(documentPaths)
        }
        if (imagePaths.length > 0 && imageAttachmentsSupported) {
          const files = await readImageFilesFromPaths(imagePaths)
          if (files.length > 0) {
            await processImageFiles(files)
          }
        }
        if (audioPaths.length > 0) {
          const files = await readAudioFilesFromPaths(audioPaths)
          if (files.length > 0) {
            await processAudioFiles(files)
          }
        }
        if (videoPaths.length > 0) {
          const files = await readVideoFilesFromPaths(videoPaths)
          if (files.length > 0) {
            await processVideoFiles(files)
          }
        }
      })
      .then(addUnlistener)

    return () => {
      cancelled = true
      unlisteners.forEach((unlisten) => unlisten())
    }
  }, [
    dropAcceptsAnything,
    attachDocumentPaths,
    attachmentsEnabled,
    imageAttachmentsSupported,
    audioSupported,
    videoSupported,
    processAudioFiles,
    processImageFiles,
    processVideoFiles,
    readAudioFilesFromPaths,
    readImageFilesFromPaths,
    readVideoFilesFromPaths,
    serviceHub,
  ])

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (dropAcceptsAnything) {
      setIsDragOver(true)
    }
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    // Only set dragOver to false if we're leaving the drop zone entirely
    // In Tauri, relatedTarget can be null, so we need to handle that case
    const relatedTarget = e.relatedTarget as Node | null
    if (!relatedTarget || !e.currentTarget.contains(relatedTarget)) {
      setIsDragOver(false)
    }
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (dropAcceptsAnything) {
      setIsDragOver(true)
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)

    if (!dropAcceptsAnything) return
    if (!e.dataTransfer) {
      console.warn('No dataTransfer available in drop event')
      return
    }

    const dropped = Array.from(e.dataTransfer.files ?? [])
    if (dropped.length === 0) return

    const isAudioFile = (file: File) =>
      file.type === 'audio/wav' ||
      file.type === 'audio/x-wav' ||
      file.type === 'audio/mpeg' ||
      file.type === 'audio/mp3' ||
      isAudioFileName(file.name)
    const isVideoFile = (file: File) =>
      file.type.startsWith('video/') || isVideoFileName(file.name)
    const isImageFile = (file: File) =>
      file.type.startsWith('image/') || isImageFileName(file.name)

    const audioOnes = audioSupported ? dropped.filter(isAudioFile) : []
    const videoOnes = videoSupported ? dropped.filter(isVideoFile) : []
    const imageOnes = imageAttachmentsSupported
      ? dropped.filter(
          (file) =>
            isImageFile(file) &&
            !audioOnes.includes(file) &&
            !videoOnes.includes(file)
        )
      : []
    const documentOnes = attachmentsEnabled
      ? dropped.filter(
          (file) =>
            !audioOnes.includes(file) &&
            !videoOnes.includes(file) &&
            !imageOnes.includes(file)
        )
      : []
    const documentPaths = documentOnes
      .map(getDroppedFilePath)
      .filter((path): path is string => !!path)

    if (documentPaths.length > 0) {
      void attachDocumentPaths(documentPaths)
    }
    if (documentOnes.length > documentPaths.length) {
      toast.error('Drop from Finder or use Add documents', {
        description: 'Document analysis needs a local file path for Divo skills.',
      })
    }
    if (imageOnes.length > 0) {
      void processImageFiles(imageOnes)
    }
    if (audioOnes.length > 0) {
      void processAudioFiles(audioOnes)
    }
    if (videoOnes.length > 0) {
      void processVideoFiles(videoOnes)
    }
  }

  const handlePaste = async (e: React.ClipboardEvent) => {
    if (audioSupported) {
      const clipboardItems = e.clipboardData?.items
      if (clipboardItems && clipboardItems.length > 0) {
        const audioFiles: File[] = []
        for (const item of Array.from(clipboardItems)) {
          if (
            item.type === 'audio/wav' ||
            item.type === 'audio/x-wav' ||
            item.type === 'audio/mpeg' ||
            item.type === 'audio/mp3'
          ) {
            const f = item.getAsFile()
            if (f) audioFiles.push(f)
          }
        }
        if (audioFiles.length > 0) {
          e.preventDefault()
          await processAudioFiles(audioFiles)
          return
        }
      }
    }

    if (imageAttachmentsSupported) {
      const clipboardItems = e.clipboardData?.items
      let hasProcessedImage = false

      // Try clipboardData.items first (traditional method)
      if (clipboardItems && clipboardItems.length > 0) {
        const imageItems = Array.from(clipboardItems).filter((item) =>
          item.type.startsWith('image/')
        )

        if (imageItems.length > 0) {
          e.preventDefault()

          const files: File[] = []
          let processedCount = 0

          imageItems.forEach((item) => {
            const file = item.getAsFile()
            if (file) {
              files.push(file)
            }
            processedCount++

            // When all items are processed, handle the valid files
            if (processedCount === imageItems.length) {
              if (files.length > 0) {
                const syntheticEvent = {
                  target: {
                    files: files,
                  },
                } as unknown as React.ChangeEvent<HTMLInputElement>

                handleFileChange(syntheticEvent)
                hasProcessedImage = true
              }
            }
          })

          // If we found image items but couldn't get files, fall through to modern API
          if (processedCount === imageItems.length && !hasProcessedImage) {
            // Continue to modern clipboard API fallback below
          } else {
            return // Successfully processed with traditional method
          }
        }
      }

      // Modern Clipboard API fallback (for Linux, images copied from web, etc.)
      if (
        navigator.clipboard &&
        'read' in navigator.clipboard &&
        !hasProcessedImage
      ) {
        try {
          const clipboardContents = await navigator.clipboard.read()
          const files: File[] = []

          for (const item of clipboardContents) {
            const imageTypes = item.types.filter((type) =>
              type.startsWith('image/')
            )

            for (const type of imageTypes) {
              try {
                const blob = await item.getType(type)
                // Convert blob to File with better naming
                const extension = type.split('/')[1] || 'png'
                const file = new File(
                  [blob],
                  `pasted-image-${Date.now()}.${extension}`,
                  { type }
                )
                files.push(file)
              } catch (error) {
                console.error('Error reading clipboard item:', error)
              }
            }
          }

          if (files.length > 0) {
            e.preventDefault()
            const syntheticEvent = {
              target: {
                files: files,
              },
            } as unknown as React.ChangeEvent<HTMLInputElement>

            handleFileChange(syntheticEvent)
            return
          }
        } catch (error) {
          console.error('Clipboard API access failed:', error)
        }
      }

      // If we reach here, no image was found - allow normal text pasting to continue
      console.log(
        'No image data found in clipboard, allowing normal text paste'
      )
    }
    // If image attachments are unsupported or no images are found, allow normal text pasting to continue.
  }

  const isStreaming = chatStatus === 'submitted' || chatStatus === 'streaming'
  const isComposerBusy = isStreaming || isThreadBusy

  /**
   * Whether this composer already sits under a conversation.
   *
   * The rolling suggestions are an EMPTY-STATE affordance: they teach what Divo
   * is for when there is nothing on screen to infer it from. Once a thread has
   * messages that job is done — the answer above the composer is the context,
   * and a carousel of unrelated starters ("Reconcile last month's payments")
   * animating under a finished Google Workspace run reads as the app changing
   * the subject. A follow-up prompt is the honest label there.
   */
  const hasConversation = (threadMessages?.length ?? 0) > 0

  /**
   * The rolling placeholder is for an EMPTY, idle composer on a FRESH thread.
   * It stops the moment there is anything to send — text or an attachment — so
   * suggestions never animate underneath real content, and it stays out of the
   * way while a turn is streaming.
   */
  const showRotatingPlaceholder =
    !prompt && !hasSendableAttachments && !isComposerBusy && !hasConversation

  const activeApproval = visibleApprovalQueue[approvalQueueIndex]
  if (
    activeApproval &&
    displayedThreadId &&
    activeApproval.threadId === displayedThreadId &&
    (!activePiRunId || activeApproval.runId === activePiRunId)
  ) {
    return (
      <LiveApprovalComposer
        request={activeApproval}
        position={approvalQueueIndex}
        total={visibleApprovalQueue.length}
        now={approvalClock}
        onMove={(direction) =>
          setApprovalQueueIndex((current) => {
            const next = current + direction
            return (
              (next + visibleApprovalQueue.length) %
              visibleApprovalQueue.length
            )
          })
        }
        onDecision={(confirmed) =>
          void resolvePiApproval(
            activeApproval.threadId,
            activeApproval.requestId,
            confirmed,
            activeApproval.runId
          )
        }
        onAllowBashForChat={() => {
          void allowBashForChat(
            activeApproval.threadId,
            activeApproval.requestId,
            activeApproval.runId
          ).then((allowed) => {
            if (!allowed) return
            toast.success('Bash commands are allowed for this chat.')
          })
        }}
        onAllowFullAccessForChat={() => {
          void allowFullAccessForChat(
            activeApproval.threadId,
            activeApproval.requestId,
            activeApproval.runId
          ).then((allowed) => {
            if (!allowed) return
            toast.success('Divo has full local access for this chat.')
          })
        }}
        onStop={() => {
          void usePiApproval
            .getState()
            .denyThread(activeApproval.threadId, activeApproval.runId)
            .finally(() => stopStreaming(activeApproval.threadId))
        }}
      />
    )
  }

  // Composer input-row pieces, hoisted so the landing composer (Astryx
  // ChatComposer, in slots) and the in-thread composer (our shell, one row)
  // are driven by the SAME elements. Each closes over ChatInput's state, so
  // moving one into a slot relocates where it renders without changing what it
  // does — which is how the two composers stay behaviourally identical while
  // looking different.

  // The `+` attachment menu.
  const composerAttachMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Add attachment"
          className="size-[29px] rounded-full text-muted-foreground hover:text-foreground"
        >
          <PlusIcon size={16} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {imageAttachmentsSupported && (
          <DropdownMenuItem onClick={() => void openImagePicker()}>
            <IconPhoto size={18} className="text-muted-foreground" />
            <span>Add Images</span>
            <input
              type="file"
              ref={fileInputRef}
              className="hidden"
              multiple
              onChange={handleFileChange}
            />
          </DropdownMenuItem>
        )}
        {audioSupported && (
          <DropdownMenuItem onClick={() => void openAudioPicker()}>
            <IconMusic size={18} className="text-muted-foreground" />
            <span>Add Audio</span>
            <input
              type="file"
              ref={audioInputRef}
              className="hidden"
              multiple
              accept="audio/wav,audio/mpeg,.wav,.mp3"
              onChange={handleAudioFileChange}
            />
          </DropdownMenuItem>
        )}
        {videoSupported && (
          <DropdownMenuItem onClick={() => void openVideoPicker()}>
            <IconVideo size={18} className="text-muted-foreground" />
            <span>Add Video</span>
            <input
              type="file"
              ref={videoInputRef}
              className="hidden"
              multiple
              accept="video/mp4,video/quicktime,video/webm,video/x-matroska,video/x-msvideo,.mp4,.mov,.webm,.mkv,.avi,.m4v"
              onChange={handleVideoFileChange}
            />
          </DropdownMenuItem>
        )}
        {/* Local file references for Divo document and OCR skills. */}
        <DropdownMenuItem
          onClick={handleAttachDocsIngest}
          disabled={ingestingDocs}
        >
          {ingestingDocs ? (
            <IconLoader2
              size={18}
              className="text-muted-foreground animate-spin"
            />
          ) : (
            <IconPaperclip
              size={18}
              className="text-muted-foreground"
            />
          )}
          <span>
            {ingestingDocs
              ? 'Indexing documents…'
              : 'Add documents or files'}
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )

  // The prompt textarea. Carries the `/` menu, IME handling, history nav and
  // Enter-to-send — none of which any slot may intercept.
  const composerPromptField = (
    <div className="relative min-w-0 flex-1">
      <TextareaAutosize
        dir="auto"
        ref={textareaRef}
        minRows={1}
        rows={1}
        maxRows={10}
        value={prompt}
        data-testid={'chat-input'}
        onChange={(e) => {
          const nextPrompt = e.target.value
          setPrompt(nextPrompt)
          const slashSearch = nextPrompt.match(/^\/([^\n]*)$/)
          if (slashSearch) {
            setSkillReferenceDrawerOpen(true)
            setSkillReferenceSearch(slashSearch[1] ?? '')
          } else if (skillReferenceDrawerOpen) {
            setSkillReferenceDrawerOpen(false)
            setSkillReferenceSearch('')
            setSkillReferenceError(null)
            setSkillReferenceResults([])
          }
          const newRows = (nextPrompt.match(/\n/g) || []).length + 1
          setRows(Math.min(newRows, maxRows))
        }}
        onKeyDown={(e) => {
          const isComposing =
            e.nativeEvent.isComposing || e.keyCode === 229

          if (skillReferenceDrawerOpen && !isComposing) {
            if (e.key === 'Escape') {
              e.preventDefault()
              setSkillReferenceDrawerOpen(false)
              setSkillReferenceSearch('')
              setSkillReferenceError(null)
              setSkillReferenceResults([])
              return
            }
            if (
              e.key === 'Enter' &&
              !e.shiftKey &&
              matchesShareMemoryCommand(skillReferenceSearch)
            ) {
              e.preventDefault()
              activateShareMemoryCommand()
              return
            }
          }

          if (e.key === 'Enter' && !e.shiftKey && !isComposing) {
            e.preventDefault()
            if ((prompt.trim() || hasSendableAttachments) && !ingestingAny) {
              handleSendMessage(prompt)
            }
          }
          if (e.key === 'ArrowUp' && !isComposing) {
            const textarea = e.currentTarget
            const cursorAtStart =
              textarea.selectionStart === 0 &&
              textarea.selectionEnd === 0
            if (cursorAtStart || !prompt) {
              e.preventDefault()
              navigateHistory('up')
            }
          }
          if (e.key === 'ArrowDown' && !isComposing) {
            const textarea = e.currentTarget
            const cursorAtEnd =
              textarea.selectionStart === prompt.length &&
              textarea.selectionEnd === prompt.length
            if (cursorAtEnd) {
              e.preventDefault()
              navigateHistory('down')
            }
          }
        }}
        onPaste={handlePaste}
        placeholder={t(
          hasConversation
            ? 'common:placeholder.chatFollowUp'
            : 'common:placeholder.chatInput'
        )}
        autoFocus
        spellCheck={spellCheckChatInput}
        data-gramm={spellCheckChatInput}
        data-gramm_editor={spellCheckChatInput}
        data-gramm_grammarly={spellCheckChatInput}
        className={cn(
          'w-full resize-none border-none bg-transparent px-1.5 py-1 text-[14px] leading-5 outline-0',
          !initialMessage && 'translate-y-[3px]',
          showRotatingPlaceholder && 'placeholder:text-transparent',
          rows < maxRows && 'scrollbar-hide',
          className
        )}
      />
      {showRotatingPlaceholder && (
        <RotatingPlaceholder className="px-1.5 text-[13px]" />
      )}
    </div>
  )

  // Model selector.
  const composerModelToggle = (
    <div
      className={cn(
        '[&_button]:h-6 [&_button]:gap-0.5 [&_button]:px-1.5 [&_button]:text-[11px]',
        isComposerBusy && 'opacity-50 pointer-events-none'
      )}
    >
      <DivoModelToggle disabled={isComposerBusy} />
    </div>
  )

  // Send while idle, stop while streaming.
  const composerSendControl = isComposerBusy ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="destructive"
          size="icon-sm"
          aria-label="Stop generating"
          className="size-[29px] rounded-full"
          onClick={() => {
            if (displayedThreadId) stopStreaming(displayedThreadId)
          }}
        >
          <IconPlayerStopFilled />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        <p>Stop generating</p>
      </TooltipContent>
    </Tooltip>
  ) : (
    <Button
      variant="default"
      size="icon-sm"
      disabled={
        (!prompt.trim() && !hasSendableAttachments) || ingestingAny
      }
      data-test-id="send-message-button"
      onClick={() => handleSendMessage(prompt)}
      className="size-[29px] rounded-full"
    >
      <ArrowUp className="size-[15px] text-primary-fg" />
    </Button>
  )

  return (
    <div className="relative">
      {/* The `/` menu floats ABOVE the composer rather than growing inside it.
          It has to live out here: the composer shell is `overflow-hidden` for
          the MovingBorder effect, which would clip a popover rendered within. */}
      {skillReferenceDrawerOpen && (
        <div className="absolute bottom-full left-0 z-50 mb-2">
          <SkillReferenceDrawer
            search={skillReferenceSearch}
            loading={skillReferenceLoading}
            error={skillReferenceError}
            results={skillReferenceResults}
            commands={
              matchesShareMemoryCommand(skillReferenceSearch) ? (
                <>
                  <div className="px-3 pt-2.5 pb-1 text-[11px] font-normal text-muted-foreground/70">
                    Commands
                  </div>
                  <button
                    type="button"
                    data-testid="share-memory-command"
                    className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm text-foreground hover:bg-accent"
                    onClick={activateShareMemoryCommand}
                  >
                    <IconBrain size={16} className="shrink-0 text-muted-foreground/70" />
                    <span className="min-w-0 flex-1 truncate">
                      {SHARE_MEMORY_COMMAND}
                    </span>
                    <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground/60">
                      Enter
                    </span>
                  </button>
                </>
              ) : null
            }
            onSelect={(skill) => {
              setSelectedSkillReferences((current) =>
                current.some((item) => item.id === skill.id)
                  ? current
                  : [...current, skill]
              )
              setSkillReferenceDrawerOpen(false)
              setSkillReferenceSearch('')
              setSkillReferenceError(null)
              setSkillReferenceResults([])
              setPrompt('')
              textareaRef.current?.focus()
            }}
          />
        </div>
      )}
      {/* The composer shell owns MovingBorder, drag-drop and focus; the body
          below is the same either way. `initialMessage` marks the landing. */}
      <DivoComposerShell
        variant={initialMessage ? 'landing' : 'thread'}
        isComposerBusy={isComposerBusy}
        isFocused={isFocused}
        isDragOver={isDragOver}
        dropAcceptsAnything={dropAcceptsAnything}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
            {attachments.length > 0 && (
              <div className="flex flex-col gap-2 p-2 pb-0">
                <div className="flex gap-3 items-center">
                  {attachments
                    .map((att, idx) => ({ att, idx }))
                    .map(({ att, idx }) => {
                      const isImage = att.type === 'image'
                      const isAudio = att.type === 'audio'
                      const isVideo = att.type === 'video'
                      const ext = att.fileType || att.mimeType?.split('/')[1]
                      const durLabel =
                        isAudio && typeof att.durationSec === 'number'
                          ? `${Math.floor(att.durationSec / 60)}:${Math.floor(att.durationSec % 60)
                              .toString()
                              .padStart(2, '0')}`
                          : undefined
                      return (
                        <div
                          key={`${att.type}-${idx}-${att.name}`}
                          className="relative"
                        >
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div
                                className={cn(
                                  'relative border rounded-xl size-14 overflow-hidden',
                                  'flex items-center justify-center'
                                )}
                              >
                                {isImage && att.dataUrl ? (
                                  <img
                                    className="object-cover w-full h-full"
                                    src={att.dataUrl}
                                    alt={`${att.name}`}
                                  />
                                ) : isAudio ? (
                                  <div className="flex flex-col items-center justify-center text-muted-foreground">
                                    <IconMusic size={20} />
                                    {durLabel && (
                                      <span className="text-[10px] leading-none mt-0.5 tabular-nums opacity-70">
                                        {durLabel}
                                      </span>
                                    )}
                                  </div>
                                ) : isVideo ? (
                                  <div className="flex flex-col items-center justify-center text-muted-foreground">
                                    <IconVideo size={20} />
                                  </div>
                                ) : (
                                  <div className="flex flex-col items-center justify-center text-muted-foreground">
                                    <IconPaperclip size={18} />
                                    {ext && (
                                      <span className="text-[10px] leading-none mt-0.5 uppercase opacity-70">
                                        .{ext}
                                      </span>
                                    )}
                                  </div>
                                )}
                              </div>
                            </TooltipTrigger>
                            <TooltipContent>
                              <div className="text-xs">
                                <div
                                  className="font-medium truncate max-w-52"
                                  title={att.name}
                                >
                                  {att.name}
                                </div>
                                <div className="opacity-70">
                                  {isImage
                                    ? att.mimeType || 'image'
                                    : isAudio
                                      ? att.audioFormat
                                        ? `.${att.audioFormat}${durLabel ? ` · ${durLabel}` : ''}`
                                        : 'audio'
                                      : ext
                                        ? `.${ext}`
                                        : 'document'}
                                  {att.size
                                    ? ` · ${formatBytes(att.size, {
                                        decimals: (_, unit) =>
                                          unit === 'B' ? 0 : 1,
                                      })}`
                                    : ''}
                                </div>
                                {isAudio && att.dataUrl && (
                                  <audio
                                    controls
                                    src={att.dataUrl}
                                    className="mt-1 w-56"
                                  />
                                )}
                              </div>
                            </TooltipContent>
                          </Tooltip>

                          {/* Remove button disabled while processing - outside overflow-hidden container */}
                          {!att.processing && (
                            <div
                              className="absolute -top-1 -right-2.5 bg-destructive size-5 flex rounded-full items-center justify-center cursor-pointer"
                              onClick={() => handleRemoveAttachment(idx)}
                            >
                              <IconX
                                className="text-neutral-200"
                                size={14}
                              />
                            </div>
                          )}
                        </div>
                      )
                    })}
                </div>
              </div>
            )}
            {queuedMessages.length > 0 && (
              <div className="flex flex-col gap-1 px-3 pt-2 pb-0">
                <div className="flex items-center justify-between px-1 text-xs text-muted-foreground">
                  <span>{queueLength} queued</span>
                  <button
                    type="button"
                    aria-label="Clear queued messages"
                    className="hover:text-foreground transition-colors"
                    onClick={() =>
                      displayedThreadId &&
                      useMessageQueue.getState().clearQueue(displayedThreadId)
                    }
                  >
                    Clear queue
                  </button>
                </div>
                {queuedMessages.map((msg) => (
                  <QueuedMessageChip
                    key={msg.id}
                    message={msg}
                    onEdit={(queued) => {
                      if (
                        useMessageQueue
                          .getState()
                          .requestCancellation(displayedThreadId ?? '', queued.id)
                      ) {
                        toast.info('Cancelling queued message before it is sent')
                        return
                      }
                      if (
                        prompt.trim() ||
                        attachments.length > 0 ||
                        selectedSkillReferences.length > 0
                      ) {
                        toast.info(
                          'Finish or clear the current draft before editing a queued message'
                        )
                        return
                      }
                      // Transfer the detached queued snapshot back to the composer
                      // before removing it, so editing cannot lose attached files.
                      setPrompt(queued.text)
                      setSelectedSkillReferences(
                        queued.skillReferences.map((reference) => ({
                          ...reference,
                          toolIds: [...reference.toolIds],
                        }))
                      )
                      setAttachmentsForThread(attachmentsKey, () =>
                        queued.attachments.map((attachment) => ({ ...attachment }))
                      )
                      removeQueuedMessage(queued.id)
                      textareaRef.current?.focus()
                    }}
                    onRemove={removeQueuedMessage}
                  />
                ))}
              </div>
            )}
            <SkillReferenceChips
              skills={selectedSkillReferences}
              onRemove={(skillId) =>
                setSelectedSkillReferences((current) =>
                  current.filter((item) => item.id !== skillId)
                )
              }
            />

          {/* A follow-up stays a compact single row. The landing composer uses
              the same controls in a two-row grid: the prompt gets the upper
              canvas and controls remain pinned to its lower edge. */}
          <div
            className={cn(
              initialMessage
                ? 'grid min-h-[92px] w-full grid-cols-[auto_minmax(0,1fr)_auto] grid-rows-[minmax(44px,1fr)_auto] gap-x-2 gap-y-1'
                : 'flex w-full gap-1',
              !initialMessage && (rows > 1 ? 'items-end' : 'items-center')
            )}
          >
            <div
              className={cn(
                'flex shrink-0 items-center gap-0.5',
                initialMessage && 'col-start-1 row-start-2'
              )}
            >
              <div
                className={cn(
                  'flex items-center gap-1',
                  isComposerBusy && 'opacity-50 pointer-events-none'
                )}
              >
                {/* Attachments are first-class Divo inputs. */}
                {composerAttachMenu}
              </div>
              <div
                className={cn(
                  'flex min-w-0 flex-1 items-center gap-0.5',
                  isComposerBusy && 'opacity-50 pointer-events-none'
                )}
              >
                {!effectiveAgentMode && hasJanBrowserMCPConfig && modelSupportsBrowser && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={isJanBrowserMCPLoading}
                        className={cn(janBrowserMCPActive && "text-primary")}
                        onClick={
                          isJanBrowserMCPLoading
                            ? undefined
                            : handleBrowseClick
                        }
                      >
                        {isJanBrowserMCPLoading ? (
                          <IconLoader2
                            size={18}
                            className="text-primary animate-spin"
                          />
                        ) : (
                          <IconBrandChrome
                            size={18}
                            className={cn(
                              'text-muted-foreground',
                              janBrowserMCPActive && 'text-primary'
                            )}
                          />
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>
                        {isJanBrowserMCPLoading
                          ? 'Starting...'
                          : janBrowserMCPActive
                            ? 'Browse (Active)'
                            : 'Browse'}
                      </p>
                    </TooltipContent>
                  </Tooltip>
                )}

                {!effectiveAgentMode && selectedModel?.capabilities?.includes('embeddings') && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                          variant="ghost"
                          size="icon-sm"
                        >
                        <IconCodeCircle2
                          size={18}
                          className="text-muted-foreground"
                        />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{t('embeddings')}</p>
                    </TooltipContent>
                  </Tooltip>
                )}


                {!effectiveAgentMode && selectedModel?.capabilities?.includes('web_search') && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="icon-sm">
                        <IconWorld
                          size={18}
                          className="text-muted-foreground"
                        />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>Web Search</p>
                    </TooltipContent>
                  </Tooltip>
                )}

                {!effectiveAgentMode &&
                  selectedProvider === 'llamacpp' &&
                  (() => {
                    const reasoningValue =
                      (selectedModel?.settings?.reasoning?.controller_props
                        ?.value as 'auto' | 'on' | 'off' | undefined) ?? 'auto'
                    const setReasoning = (value: 'auto' | 'on' | 'off') => {
                      if (!selectedProvider || !selectedModel) return
                      const providerObj = getProviderByName(selectedProvider)
                      if (!providerObj) return
                      const modelIndex = providerObj.models.findIndex(
                        (m) => m.id === selectedModel.id
                      )
                      if (modelIndex === -1) return
                      const existing =
                        selectedModel.settings?.reasoning ?? {
                          key: 'reasoning',
                          title: 'Reasoning',
                          description: '',
                          controller_type: 'dropdown',
                          controller_props: { value },
                        }
                      const updatedModel = {
                        ...selectedModel,
                        settings: {
                          ...selectedModel.settings,
                          reasoning: {
                            ...existing,
                            controller_props: {
                              ...(existing.controller_props ?? {}),
                              value,
                            },
                          },
                        },
                      } as Model
                      const updatedModels = [...providerObj.models]
                      updatedModels[modelIndex] = updatedModel
                      updateProvider(selectedProvider, {
                        models: updatedModels,
                      })
                      // selectedModel is a snapshot, not a live derivation —
                      // re-select to refresh it so the dropdown UI and the
                      // chat transport both observe the new value.
                      selectModelProvider(selectedProvider, selectedModel.id)
                    }
                    const label =
                      reasoningValue === 'on'
                        ? 'On'
                        : reasoningValue === 'off'
                          ? 'Off'
                          : 'Auto'
                    const tooltipText =
                      reasoningValue === 'on'
                        ? 'Reasoning forced on for every request.'
                        : reasoningValue === 'off'
                          ? 'Reasoning disabled for every request.'
                          : "Reasoning auto-detected from the model's chat template."
                    return (
                      <DropdownMenu>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`Reasoning: ${label}`}
                              >
                                <IconBrain
                                  size={18}
                                  className={cn(
                                    'text-muted-foreground',
                                    reasoningValue === 'on' && 'text-primary',
                                    reasoningValue === 'off' && 'opacity-50'
                                  )}
                                />
                              </Button>
                            </DropdownMenuTrigger>
                          </TooltipTrigger>
                          <TooltipContent>
                            <p>{tooltipText}</p>
                          </TooltipContent>
                        </Tooltip>
                        <DropdownMenuContent align="start">
                          <DropdownMenuItem onClick={() => setReasoning('auto')}>
                            Auto
                            {reasoningValue === 'auto' && (
                              <span className="ml-auto text-xs text-muted-foreground">
                                ✓
                              </span>
                            )}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setReasoning('on')}>
                            On
                            {reasoningValue === 'on' && (
                              <span className="ml-auto text-xs text-muted-foreground">
                                ✓
                              </span>
                            )}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setReasoning('off')}>
                            Off
                            {reasoningValue === 'off' && (
                              <span className="ml-auto text-xs text-muted-foreground">
                                ✓
                              </span>
                            )}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )
                  })()}
              </div>
            </div>

            {/* The prompt shares the row with the controls, so the model
                name and send sit on the SAME line as the placeholder
                rather than on a strip beneath it. */}
            <div
              className={cn(
                'min-w-0 flex-1',
                initialMessage && 'col-span-3 col-start-1 row-start-1 self-stretch'
              )}
            >
              {composerPromptField}
            </div>

            <div
              className={cn(
                'flex items-center gap-2',
                initialMessage && 'col-start-3 row-start-2'
              )}
            >
              {/* The model name sits on the RIGHT, immediately before send —
                  Cursor's arrangement. It reads as "which model will answer
                  this", which belongs next to the send affordance rather than
                  grouped with the input tools on the far left. */}
              {composerModelToggle}

              {selectedProvider === 'llamacpp' &&
                tokenCounterCompact &&
                !effectiveAgentMode &&
                !initialMessage &&
                (threadMessages?.length > 0 || prompt.trim().length > 0) && (
                  <div className="flex-1 flex justify-center">
                    <TokenCounter
                      messages={threadMessages || []}
                      compact={true}
                    />
                  </div>
                )}

              {composerSendControl}
            </div>
          </div>
      </DivoComposerShell>

      <ArtifactOpener
        messages={threadMessages ?? []}
        activeRootId={activeBranchRootId}
      />
      <ArtifactFileRefresh
        messages={threadMessages ?? []}
        activeRootId={activeBranchRootId}
      />

      {!initialMessage && (
        <div
          className="mt-2 flex min-w-0 items-center gap-2.5 px-4.5 text-[13px] text-muted-foreground/80"
          data-testid="composer-status-row"
        >
          <div className="flex shrink-0 items-center gap-1.5">
            <GitBranch className="size-3.5" aria-hidden="true" />
            <span>Divo</span>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Laptop className="size-3.5" aria-hidden="true" />
            <span>This Mac</span>
          </div>
          <TodoBubble
            threadId={displayedThreadId}
            messages={threadMessages ?? []}
            activeRootId={activeBranchRootId}
          />
          <LoaderCircle
            className={cn('ml-auto size-[18px] text-muted-foreground/75', isComposerBusy && 'animate-spin')}
            aria-label={isComposerBusy ? 'Divo is working' : 'Divo ready'}
          />
        </div>
      )}

      {message && (
        <div className="-mt-0.5 mx-2 pb-2 px-3 pt-1.5 rounded-b-lg text-xs text-destructive transition-all duration-200 ease-in-out">
          <div className="flex items-center gap-1 justify-between">
            {message}
            <IconX
              className="size-3 text-muted-foreground cursor-pointer"
              onClick={() => {
                setMessage('')
                // Reset file input to allow re-uploading the same file
                if (fileInputRef.current) {
                  fileInputRef.current.value = ''
                }
              }}
            />
          </div>
        </div>
      )}

      {selectedProvider === 'llamacpp' &&
        isModelActive &&
        !effectiveAgentMode &&
        !tokenCounterCompact &&
        !initialMessage &&
        (threadMessages?.length > 0 || prompt.trim().length > 0) && (
          <div className="flex-1 w-full flex justify-start px-2">
            <TokenCounter messages={threadMessages || []} />
          </div>
        )}

      <JanBrowserExtensionDialog
        open={extensionDialogOpen}
        onOpenChange={setExtensionDialogOpen}
        state={extensionDialogState}
        onCancel={handleExtensionDialogCancel}
      />
    </div>
  )
})

export default ChatInput
