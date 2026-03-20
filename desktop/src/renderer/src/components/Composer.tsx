import { useState, useRef, useEffect, useCallback } from 'react'
import { ArrowUp, AtSign, ChevronDown, Paperclip, Square, X, FileText, Image, File, Infinity, Zap, Flame, Rocket, ShieldAlert, CheckCircle2, Ban, Workflow } from 'lucide-react'
import { cn } from '../lib/utils'
import { useAuth } from '../context/AuthContext'
import { useChat } from '../context/ChatContext'
import { useWorkspace } from '../context/WorkspaceContext'
import { PlanDrawer } from './PlanDrawer'
import { FilesDrawer, type FileAssetRecord } from './FilesDrawer'

type ComposerMode = 'fast' | 'high' | 'xtreme'

type SavedWorkflowSummary = {
  id: string
  name: string
  status: 'draft' | 'published' | 'scheduled_active' | 'paused' | 'archived'
  compiledPrompt: string
  aiDraft?: string | null
  capabilitySummary?: { requiresPublishApproval?: boolean } | null
}

// ─── File attachment types ─────────────────────────────────────────────────────

type AttachedFile = {
  id: string
  file: File
  name: string
  mimeType: string
  sizeBytes: number
  status: 'idle' | 'uploading' | 'done' | 'error'
  fileAssetId?: string
  cloudinaryUrl?: string
  errorMsg?: string
}

const MAX_MB = 25
const ALLOWED_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'text/plain',
  'text/markdown',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
])

const MODE_OPTIONS: Array<{
  value: ComposerMode
  label: string
  description: string
  title: string
  icon: typeof Zap
  iconClassName: string
}> = [
  {
    value: 'fast',
    label: 'Fast',
    description: 'Lightweight routing, lower cost',
    title: 'Fast mode - lightweight routing, lower cost',
    icon: Zap,
    iconClassName: 'text-amber-500',
  },
  {
    value: 'high',
    label: 'High',
    description: 'Flagship models, full capability',
    title: 'High mode - flagship models, full capability',
    icon: Flame,
    iconClassName: 'text-primary',
  },
  {
    value: 'xtreme',
    label: 'Xtreme',
    description: 'Groq instant routing + Gemini deep planning',
    title: 'Xtreme hybrid - Groq instant routing + Gemini deep planning',
    icon: Rocket,
    iconClassName: 'text-purple-400',
  },
]

// ─── Helper: icon per MIME type ────────────────────────────────────────────────

function FileIcon({ mimeType, size = 13 }: { mimeType: string; size?: number }) {
  if (mimeType.startsWith('image/')) return <Image size={size} />
  if (mimeType === 'application/pdf') return <FileText size={size} />
  return <File size={size} />
}

// ─── Single file reference card ───────────────────────────────────────────────

function FileCard({ attachment, onRemove }: { attachment: AttachedFile; onRemove: (id: string) => void }) {
  const isUploading = attachment.status === 'uploading'
  const isError = attachment.status === 'error'
  const isDone = attachment.status === 'done'

  const shortName = attachment.name.length > 24
    ? attachment.name.slice(0, 20) + '…' + attachment.name.slice(attachment.name.lastIndexOf('.'))
    : attachment.name

  const sizeMb = (attachment.sizeBytes / 1024 / 1024).toFixed(1)

  return (
    <div
      className={cn(
        'group relative flex items-center gap-2 rounded-[10px] border px-2.5 py-1.5 text-[12px] font-medium transition-all duration-150',
        'bg-muted/50',
        isError
          ? 'border-red-900/50 text-red-400'
          : isDone
            ? 'border-emerald-900/50 text-emerald-400'
            : 'border-border text-foreground/80',
      )}
      title={attachment.errorMsg ?? attachment.name}
    >
      {/* icon */}
      <span className={cn('shrink-0', isError ? 'text-red-400' : isDone ? 'text-emerald-500' : 'text-muted-foreground')}>
        <FileIcon mimeType={attachment.mimeType} size={13} />
      </span>

      {/* name + size */}
      <div className="flex flex-col leading-none">
        <span className="truncate leading-snug">{shortName}</span>
        {isError ? (
          <span className="text-[10px] text-red-400/80 leading-snug">{attachment.errorMsg ?? 'Upload failed'}</span>
        ) : (
          <span className="text-[10px] text-muted-foreground/60 leading-snug">{sizeMb} MB</span>
        )}
      </div>

      {/* spinner or done indicator */}
      {isUploading && (
        <span className="ml-0.5 h-3 w-3 shrink-0 animate-spin rounded-full border border-muted-foreground/30 border-t-primary" />
      )}

      {/* remove button */}
      {!isUploading && (
        <button
          type="button"
          onClick={() => onRemove(attachment.id)}
          className="ml-0.5 shrink-0 rounded p-0.5 text-muted-foreground/80 opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground"
          aria-label="Remove file"
        >
          <X size={11} />
        </button>
      )}
    </div>
  )
}

// ─── Main Composer ─────────────────────────────────────────────────────────────

export function Composer({ isHome }: { isHome?: boolean }): JSX.Element {
  const { token } = useAuth()
  const { sendMessage, sendInitialMessage, stopExecution, isStreaming, activeThread, activePlan, pendingLocalAction, approveCommand, rejectCommand } = useChat()
  const { currentWorkspace } = useWorkspace()
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<AttachedFile[]>([])
  const [isDragOver, setIsDragOver] = useState(false)
  const [isDrawerOpen, setIsDrawerOpen] = useState(false)
  const [mode, setMode] = useState<ComposerMode>('high')
  const [isModeMenuOpen, setIsModeMenuOpen] = useState(false)
  const [isReferenceMenuOpen, setIsReferenceMenuOpen] = useState(false)
  const [workflowOptions, setWorkflowOptions] = useState<SavedWorkflowSummary[]>([])
  const [referenceFileOptions, setReferenceFileOptions] = useState<FileAssetRecord[]>([])
  const [isLoadingReferences, setIsLoadingReferences] = useState(false)
  const [selectedWorkflow, setSelectedWorkflow] = useState<SavedWorkflowSummary | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const modeMenuRef = useRef<HTMLDivElement>(null)
  const workflowMenuRef = useRef<HTMLDivElement>(null)

  const canSend = (text.trim().length > 0 || attachments.some(a => a.status === 'done'))
    || Boolean(selectedWorkflow)
  const canSubmit = canSend
    && !isStreaming
    && (isHome || !!activeThread)
    && attachments.every(a => a.status !== 'uploading')

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 160)}px`
    }
  }, [text])

  useEffect(() => {
    if (!isModeMenuOpen) return

    const handlePointerDown = (event: MouseEvent) => {
      if (modeMenuRef.current && !modeMenuRef.current.contains(event.target as Node)) {
        setIsModeMenuOpen(false)
      }
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsModeMenuOpen(false)
    }

    window.addEventListener('mousedown', handlePointerDown)
    window.addEventListener('keydown', handleEscape)
    return () => {
      window.removeEventListener('mousedown', handlePointerDown)
      window.removeEventListener('keydown', handleEscape)
    }
  }, [isModeMenuOpen])

  useEffect(() => {
    if (!isReferenceMenuOpen) return

    const handlePointerDown = (event: MouseEvent) => {
      if (workflowMenuRef.current && !workflowMenuRef.current.contains(event.target as Node)) {
        setIsReferenceMenuOpen(false)
      }
    }

    window.addEventListener('mousedown', handlePointerDown)
    return () => {
      window.removeEventListener('mousedown', handlePointerDown)
    }
  }, [isReferenceMenuOpen])

  const loadReferenceOptions = useCallback(async () => {
    if (!token) return
    setIsLoadingReferences(true)
    try {
      const [workflowResponse, filesResponse] = await Promise.all([
        window.desktopAPI.fetch('/api/desktop/workflows', {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }),
        window.desktopAPI.files.list(token),
      ])
      if (workflowResponse.status >= 200 && workflowResponse.status < 300) {
        const parsed = JSON.parse(workflowResponse.body) as { data?: SavedWorkflowSummary[] }
        setWorkflowOptions((parsed.data ?? []).filter((workflow) => workflow.status !== 'archived'))
      }
      if (filesResponse.success) {
        const payload = filesResponse.data as { data?: { files?: FileAssetRecord[] } }
        setReferenceFileOptions(payload?.data?.files ?? [])
      }
    } catch {
      // ignore picker load failures in composer
    } finally {
      setIsLoadingReferences(false)
    }
  }, [token])

  useEffect(() => {
    const match = text.match(/(?:^|\s)@([^\s@]*)$/)
    if (!match || (!activeThread && !isHome) || isStreaming) {
      return
    }
    setIsReferenceMenuOpen(true)
    if (workflowOptions.length === 0 && referenceFileOptions.length === 0) {
      void loadReferenceOptions()
    }
  }, [text, activeThread, isHome, isStreaming, workflowOptions.length, referenceFileOptions.length, loadReferenceOptions])

  // ── Upload logic ──────────────────────────────────────────────────────────────
  const uploadFile = useCallback(async (attachment: AttachedFile) => {
    setAttachments(prev =>
      prev.map(a => a.id === attachment.id ? { ...a, status: 'uploading' } : a)
    )
    try {
      if (!token) throw new Error('Not authenticated')
      // Read as ArrayBuffer — the only way to pass binary through Electron IPC
      const arrayBuffer = await attachment.file.arrayBuffer()
      const result = await window.desktopAPI.files.upload(
        token,
        arrayBuffer,
        attachment.name,
        attachment.mimeType,
      )
      if (!result.success) {
        const msg = (result.data as { message?: string })?.message ?? `Server error ${result.status}`
        throw new Error(msg)
      }
      const pData = result.data as { data?: { fileAssetId?: string; cloudinaryUrl?: string } }
      const fileAssetId = pData?.data?.fileAssetId
      const cloudinaryUrl = pData?.data?.cloudinaryUrl
      setAttachments(prev =>
        prev.map(a => a.id === attachment.id ? { ...a, status: 'done', fileAssetId, cloudinaryUrl } : a)
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Upload failed'
      setAttachments(prev =>
        prev.map(a => a.id === attachment.id ? { ...a, status: 'error', errorMsg: msg } : a)
      )
    }
  }, [token])

  // ── Accept files ──────────────────────────────────────────────────────────────
  const acceptFiles = useCallback((files: FileList | File[]) => {
    const newAttachments: AttachedFile[] = []
    for (const file of Array.from(files)) {
      if (file.size > MAX_MB * 1024 * 1024) continue
      if (!ALLOWED_TYPES.has(file.type)) continue
      const attachment: AttachedFile = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        file,
        name: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        status: 'idle',
      }
      newAttachments.push(attachment)
    }
    if (newAttachments.length === 0) return
    setAttachments(prev => [...prev, ...newAttachments])
    // kick off uploads
    newAttachments.forEach(a => void uploadFile(a))
  }, [uploadFile])

  // ── Drag & drop ───────────────────────────────────────────────────────────────
  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); setIsDragOver(true) }
  const handleDragLeave = () => setIsDragOver(false)
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
    if (e.dataTransfer.files.length > 0) acceptFiles(e.dataTransfer.files)
  }

  // ── Send ──────────────────────────────────────────────────────────────────────
  const handleSend = (): void => {
    if (!canSubmit) return
    const doneDocs = attachments.filter(a => a.status === 'done')
    const payloadAttachments = doneDocs
      .filter((a): a is AttachedFile & { fileAssetId: string; cloudinaryUrl: string } => !!a.fileAssetId && !!a.cloudinaryUrl)
      .map(a => ({
        fileAssetId: a.fileAssetId,
        cloudinaryUrl: a.cloudinaryUrl,
        mimeType: a.mimeType,
        fileName: a.name,
      }))

    if (isHome && !activeThread) {
      sendInitialMessage(
        text.trim(),
        payloadAttachments.length > 0 ? payloadAttachments : undefined,
        mode,
        selectedWorkflow
          ? {
            workflowId: selectedWorkflow.id,
            workflowName: selectedWorkflow.name,
            overrideText: text.trim() || undefined,
          }
          : undefined,
      )
    } else {
      sendMessage(
        text.trim(),
        payloadAttachments.length > 0 ? payloadAttachments : undefined,
        mode,
        selectedWorkflow
          ? {
            workflowId: selectedWorkflow.id,
            workflowName: selectedWorkflow.name,
            overrideText: text.trim() || undefined,
          }
          : undefined,
      )
    }
    
    setText('')
    setAttachments([])
    setSelectedWorkflow(null)
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
  }

  const handleRemoveAttachment = (id: string) => {
    setAttachments(prev => prev.filter(a => a.id !== id))
  }

  const handleReferenceDrawerFile = useCallback((file: FileAssetRecord) => {
    setAttachments(prev => {
      if (prev.some(a => a.fileAssetId === file.id)) return prev.filter(a => a.fileAssetId !== file.id)
      return [...prev, {
        id: `ref-${file.id}`,
        file: new Blob([], { type: file.mimeType }) as unknown as File, // mock file for UI
        name: file.fileName,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        status: 'done',
        fileAssetId: file.id,
        cloudinaryUrl: file.cloudinaryUrl,
      }]
    })
  }, [])

  const clearReferenceToken = useCallback(() => {
    setText((current) => current.replace(/(?:^|\s)@[^\s@]*$/, ' ').replace(/\s+$/, ''))
  }, [])

  const referencedIds = new Set(attachments.map(a => a.fileAssetId).filter(Boolean) as string[])
  const selectedMode = MODE_OPTIONS.find((option) => option.value === mode) ?? MODE_OPTIONS[1]
  const SelectedModeIcon = selectedMode.icon
  const isApprovalMode = Boolean(pendingLocalAction) && !isHome
  const referenceQuery = text.match(/(?:^|\s)@([^\s@]*)$/)?.[1]?.toLowerCase() ?? ''
  const filteredWorkflowOptions = workflowOptions.filter((workflow) =>
    !referenceQuery || workflow.name.toLowerCase().includes(referenceQuery),
  )
  const filteredFileOptions = referenceFileOptions.filter((file) =>
    !referenceQuery || file.fileName.toLowerCase().includes(referenceQuery),
  )

  const approvalTitle = pendingLocalAction
    ? pendingLocalAction.action.kind === 'tool_action'
      ? pendingLocalAction.action.title
      : pendingLocalAction.action.kind === 'run_command'
      ? 'Command approval required'
      : pendingLocalAction.action.kind === 'write_file'
        ? 'File change approval required'
        : pendingLocalAction.action.kind === 'mkdir'
          ? 'Folder creation approval required'
          : 'Delete approval required'
    : ''

  const approvalDescription = pendingLocalAction
    ? pendingLocalAction.action.kind === 'tool_action'
      ? (pendingLocalAction.action.explanation ?? 'Divo is waiting for approval before performing this action.')
      : pendingLocalAction.action.kind === 'run_command'
      ? 'Divo is waiting to run this shell command inside the selected workspace.'
      : pendingLocalAction.action.kind === 'write_file'
        ? 'Divo is waiting to write this file inside the selected workspace.'
        : pendingLocalAction.action.kind === 'mkdir'
          ? 'Divo is waiting to create this folder inside the selected workspace.'
          : 'Divo is waiting to delete this path inside the selected workspace.'
    : ''

  const pendingActionPath = pendingLocalAction
    ? pendingLocalAction.action.kind === 'tool_action'
      ? (pendingLocalAction.action.subject ?? pendingLocalAction.action.summary)
      : pendingLocalAction.action.kind === 'run_command'
      ? `$ ${pendingLocalAction.action.command}`
      : ('path' in pendingLocalAction.action ? pendingLocalAction.action.path : '')
    : ''

  return (
    <div
      className={cn("shrink-0 titlebar-no-drag transition-all", isHome ? "w-full mx-auto" : "px-5 py-3")}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".pdf,.docx,.doc,.txt,.md,.jpg,.jpeg,.png,.webp,.gif"
        className="hidden"
        onChange={(e) => { if (e.target.files) { acceptFiles(e.target.files); e.target.value = '' } }}
      />

      <div className={cn("mx-auto relative", isHome ? "w-full max-w-[760px]" : "max-w-[760px]")}>
        {isStreaming && activePlan && !isHome && <PlanDrawer plan={activePlan} />}

        <div
          className={cn(
            'relative z-10 rounded-[24px] border bg-card/95 shadow-[0_12px_36px_rgba(0,0,0,0.22)] transition-colors duration-150',
            isDragOver
              ? 'border-primary/40 shadow-[0_0_0_1px_hsl(var(--ring)/0.18),0_24px_80px_rgba(2,8,18,0.32)]'
              : activeThread || isHome
                ? 'border-border focus-within:border-primary/40'
                : 'opacity-70',
          )}
        >
          {isApprovalMode ? (
            <div className="px-4 py-4">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 rounded-xl bg-amber-950/20 p-2 text-amber-500">
                  <ShieldAlert size={16} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-medium text-foreground">{approvalTitle}</div>
                    <span className="rounded-full border border-amber-900/50 bg-amber-950/20 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-amber-400">
                      Awaiting approval
                    </span>
                  </div>
                  <div className="mt-1 text-sm text-muted-foreground">{approvalDescription}</div>
                  <div className="mt-3 rounded-2xl border border-border/60 bg-black/20 px-4 py-3 font-mono text-[13px] leading-7 text-foreground/90 whitespace-pre-wrap break-words">
                    {pendingActionPath}
                  </div>
                  {pendingLocalAction?.workspacePath ? (
                    <div className="mt-2 text-[11px] text-muted-foreground/40">
                      {pendingLocalAction.workspacePath}
                    </div>
                  ) : null}
                  <div className="mt-4 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void approveCommand(pendingLocalAction!.id)}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-sky-300/12 bg-sky-400/8 px-3.5 py-2 text-xs font-medium text-sky-50/88 hover:bg-sky-400/12"
                    >
                      <CheckCircle2 size={13} />
                      Approve
                    </button>
                    <button
                      type="button"
                      onClick={() => void rejectCommand(pendingLocalAction!.id)}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-secondary px-3.5 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary/80 hover:text-foreground"
                    >
                      <Ban size={13} />
                      Reject
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <>
          {/* ── File attachment cards row ────────────────────────────────────── */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-3.5 pt-2.5 pb-0">
              {attachments.map(a => (
                <FileCard key={a.id} attachment={a} onRemove={handleRemoveAttachment} />
              ))}
            </div>
          )}

          {/* ── Drag overlay hint ─────────────────────────────────────────────── */}
          {isDragOver && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-[20px] bg-primary/10 backdrop-blur-sm">
              <span className="text-[13px] font-medium text-primary">Drop file to attach</span>
            </div>
          )}

          {/* ── Textarea ──────────────────────────────────────────────────────── */}
          <div className="px-3.5 pt-3 pb-2.5">
            <textarea
              ref={textareaRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                isDragOver
                  ? 'Drop to attach…'
                  : isHome 
                    ? `What should we work on next in ${currentWorkspace?.name ?? 'this workspace'}?`
                    : activeThread
                      ? `Message Divo about ${currentWorkspace?.name ?? 'this workspace'}`
                      : currentWorkspace
                        ? `Create a thread in ${currentWorkspace.name} to start`
                        : 'Open a workspace folder to start'
              }
              disabled={!isHome && !activeThread}
              rows={1}
              className={cn(
                'w-full resize-none bg-transparent leading-6 tracking-[-0.01em]',
                isHome ? 'text-[16px]' : 'text-[15px]',
                'text-foreground/92 placeholder:text-muted-foreground/55',
                'focus:outline-none disabled:cursor-not-allowed min-h-[44px]',
              )}
            />

            <div className="mt-2.5 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  disabled
                  className="inline-flex h-8 items-center gap-2 rounded-xl border border-border bg-secondary px-3 text-[13px] font-medium text-foreground/80 disabled:cursor-default"
                >
                  <Infinity size={14} />
                  <span>Divo</span>
                  <ChevronDown size={13} className="text-muted-foreground" />
                </button>

                {/* ── Mode toggle ───────────────────────────────────────── */}
                <div className="relative" ref={modeMenuRef}>
                  <button
                    type="button"
                  disabled={(!activeThread && !isHome) || isStreaming}
                  onClick={() => setIsModeMenuOpen(open => !open)}
                    aria-haspopup="menu"
                    aria-expanded={isModeMenuOpen}
                    className={cn(
                      'inline-flex h-8 items-center gap-1.5 rounded-xl border px-2.5 text-[12px] font-medium transition-all select-none',
                      (!activeThread && !isHome) || isStreaming
                        ? 'border-transparent text-muted-foreground/40 cursor-not-allowed'
                        : 'border-border bg-secondary text-foreground/85 hover:bg-secondary/80'
                    )}
                    title={selectedMode.title}
                  >
                    <SelectedModeIcon size={13} className={selectedMode.iconClassName} strokeWidth={2.5} />
                    <span className="tracking-wide text-[13px]">{selectedMode.label}</span>
                    <ChevronDown
                      size={13}
                      className={cn(
                        !activeThread || isStreaming ? 'text-muted-foreground/40' : 'text-muted-foreground/80',
                        isModeMenuOpen && 'rotate-180'
                      )}
                    />
                  </button>

                  {isModeMenuOpen && (activeThread || isHome) && !isStreaming && (
                    <div className="absolute bottom-[calc(100%+8px)] left-0 z-30 min-w-[220px] overflow-hidden rounded-2xl border border-border bg-card p-1.5 shadow-xl">
                      {MODE_OPTIONS.map((option) => {
                        const OptionIcon = option.icon
                        const isSelected = option.value === mode
                        return (
                          <button
                            key={option.value}
                            type="button"
                            onClick={() => {
                              setMode(option.value)
                              setIsModeMenuOpen(false)
                            }}
                            className={cn(
                              'flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left transition-colors',
                              isSelected
                                ? 'bg-secondary text-foreground'
                                : 'text-foreground/80 hover:bg-secondary/70'
                            )}
                          >
                            <OptionIcon size={14} className={option.iconClassName} strokeWidth={2.4} />
                            <div className="min-w-0">
                              <div className="text-[13px] font-medium leading-5">{option.label}</div>
                              <div className="text-[11px] leading-4 text-muted-foreground/60">{option.description}</div>
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-1.5 ml-auto">
                <div className="relative" ref={workflowMenuRef}>
                  <button
                    type="button"
                    disabled={(!activeThread && !isHome) || isStreaming}
                    onClick={() => {
                      const next = !isReferenceMenuOpen
                      setIsReferenceMenuOpen(next)
                      if (next && workflowOptions.length === 0 && referenceFileOptions.length === 0) {
                        void loadReferenceOptions()
                      }
                    }}
                    className={cn(
                      'flex h-8 min-w-[32px] items-center justify-center rounded-xl transition-colors px-2 gap-1',
                      selectedWorkflow || referencedIds.size > 0
                        ? 'border border-emerald-300/16 bg-emerald-400/8 text-emerald-50/88'
                        : (!activeThread && !isHome) || isStreaming
                          ? 'text-muted-foreground/40 cursor-not-allowed'
                          : 'border border-transparent bg-transparent text-muted-foreground/80 hover:bg-secondary hover:text-foreground',
                    )}
                    title="Reference files or workflows"
                  >
                    <AtSign size={15} />
                    {selectedWorkflow ? <span className="max-w-[96px] truncate text-[11px]">{selectedWorkflow.name}</span> : null}
                    {!selectedWorkflow && referencedIds.size > 0 ? <span className="text-[11px] font-semibold">{referencedIds.size}</span> : null}
                  </button>

                  {isReferenceMenuOpen && (activeThread || isHome) && !isStreaming ? (
                    <div className="absolute bottom-[calc(100%+8px)] right-0 z-30 max-h-[320px] w-[320px] overflow-y-auto rounded-2xl border border-border bg-card p-1.5 shadow-xl">
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedWorkflow(null)
                          clearReferenceToken()
                          setIsReferenceMenuOpen(false)
                        }}
                        className="flex w-full items-start gap-2 rounded-xl px-3 py-2 text-left text-sm text-muted-foreground hover:bg-secondary hover:text-foreground"
                      >
                        Run normal chat
                      </button>
                      {isLoadingReferences ? (
                        <div className="px-3 py-3 text-sm text-muted-foreground">Loading references…</div>
                      ) : (
                        <>
                          <div className="px-3 pt-2 pb-1 text-[11px] uppercase tracking-[0.12em] text-muted-foreground/60">
                            Workflows
                          </div>
                          {filteredWorkflowOptions.length === 0 ? (
                            <div className="px-3 py-2 text-sm text-muted-foreground">No workflow matches.</div>
                          ) : filteredWorkflowOptions.map((workflow) => (
                            <button
                              key={workflow.id}
                              type="button"
                              onClick={() => {
                                setSelectedWorkflow(workflow)
                                clearReferenceToken()
                                setIsReferenceMenuOpen(false)
                              }}
                              className={cn(
                                'flex w-full flex-col rounded-xl px-3 py-2 text-left transition-colors',
                                selectedWorkflow?.id === workflow.id
                                  ? 'bg-secondary text-foreground'
                                  : 'text-foreground/85 hover:bg-secondary/70',
                              )}
                            >
                              <div className="flex items-center gap-2">
                                <Workflow size={13} />
                                <span className="text-[13px] font-medium">{workflow.name}</span>
                              </div>
                              <span className="mt-1 text-[11px] text-muted-foreground/70">
                                {workflow.status === 'scheduled_active' ? 'Scheduled and reusable' : workflow.status === 'paused' ? 'Paused schedule' : 'Reusable workflow'}
                              </span>
                            </button>
                          ))}

                          <div className="px-3 pt-3 pb-1 text-[11px] uppercase tracking-[0.12em] text-muted-foreground/60">
                            Files
                          </div>
                          {filteredFileOptions.length === 0 ? (
                            <div className="px-3 py-2 text-sm text-muted-foreground">No file matches.</div>
                          ) : filteredFileOptions.slice(0, 8).map((file) => (
                            <button
                              key={file.id}
                              type="button"
                              onClick={() => {
                                handleReferenceDrawerFile(file)
                                clearReferenceToken()
                                setIsReferenceMenuOpen(false)
                              }}
                              className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-foreground/85 transition-colors hover:bg-secondary/70"
                            >
                              <FileText size={13} className="text-muted-foreground/70" />
                              <div className="min-w-0">
                                <div className="truncate text-[13px] font-medium">{file.fileName}</div>
                                <div className="text-[11px] text-muted-foreground/70">{file.mimeType}</div>
                              </div>
                            </button>
                          ))}
                        </>
                      )}
                    </div>
                  ) : null}
                </div>

                {/* ── File attach button (enabled) ─────────────────────────── */}
                <button
                  type="button"
                  disabled={(!activeThread && !isHome) || isStreaming}
                  onClick={() => setIsDrawerOpen(prev => !prev)}
                  className={cn(
                    'flex h-8 w-8 items-center justify-center rounded-xl transition-colors',
                    (!activeThread && !isHome) || isStreaming
                      ? 'text-muted-foreground/40 cursor-not-allowed'
                      : isDrawerOpen
                        ? 'bg-sky-400/8 text-sky-100/82'
                        : 'border border-transparent bg-transparent text-muted-foreground/80 hover:bg-secondary hover:text-foreground',
                  )}
                  aria-label="Toggle files drawer"
                  title="Workspace Files"
                >  <Paperclip size={15} />
                </button>

                {/* ── Send button ──────────────────────────────────────────── */}
                {isStreaming ? (
                  <button
                    type="button"
                    onClick={() => { void stopExecution() }}
                    className="ml-1 shrink-0 flex h-8 w-8 items-center justify-center rounded-xl border border-sky-300/18 bg-sky-50/90 text-slate-950 shadow-[0_10px_24px_rgba(120,170,220,0.10)] transition-all hover:bg-white"
                    title="Stop generation"
                  >
                    <Square size={12} fill="currentColor" />
                  </button>
                ) : (
                  <button
                    onClick={handleSend}
                    disabled={!canSubmit}
                    className={cn(
                      'ml-1 shrink-0 h-8 w-8 rounded-xl flex items-center justify-center border transition-all',
                      canSubmit
                        ? 'border-sky-200/30 bg-sky-50/92 text-slate-950 shadow-[0_10px_24px_rgba(120,170,220,0.12)] hover:bg-white'
                        : 'border-white/6 bg-white/[0.05] text-muted-foreground/40',
                    )}
                  >
                    <ArrowUp size={14} />
                  </button>
                )}
              </div>
            </div>
          </div>
            </>
          )}
        </div>

        <p className="mt-1.5 text-center text-[9px] tracking-[0.02em] text-muted-foreground/30">
          {isApprovalMode
            ? 'Approve or reject the pending action to let Divo continue.'
            : currentWorkspace
            ? `Message Divo for grounded Zoho work, research, documents, or workspace actions in ${currentWorkspace.name}. Drag & drop or attach PDFs, DOCX, or images.`
            : 'Open a workspace folder to begin.'}
        </p>
      </div>

      <FilesDrawer
        open={isDrawerOpen}
        onClose={() => setIsDrawerOpen(false)}
        onReference={handleReferenceDrawerFile}
        referencedIds={referencedIds}
      />
    </div>
  )
}
