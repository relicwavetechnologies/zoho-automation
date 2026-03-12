import { useState, useRef, useEffect, useCallback } from 'react'
import { ArrowUp, AtSign, ChevronDown, Paperclip, Square, X, FileText, Image, File, Infinity, Zap, Flame } from 'lucide-react'
import { cn } from '../lib/utils'
import { useAuth } from '../context/AuthContext'
import { useChat } from '../context/ChatContext'
import { useWorkspace } from '../context/WorkspaceContext'
import { PlanDrawer } from './PlanDrawer'
import { FilesDrawer, type FileAssetRecord } from './FilesDrawer'

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
        'group relative flex items-center gap-2 rounded-[10px] border px-2.5 py-1.5 text-[12px] font-medium',
        'bg-[hsl(0,0%,11%)] transition-all duration-150',
        isError
          ? 'border-red-700/60 text-red-400'
          : isDone
            ? 'border-[hsl(138,40%,28%)] text-[hsl(138,60%,72%)]'
            : 'border-[hsl(0,0%,20%)] text-[hsl(0,0%,78%)]',
      )}
      title={attachment.errorMsg ?? attachment.name}
    >
      {/* icon */}
      <span className={cn('shrink-0', isError ? 'text-red-400' : isDone ? 'text-[hsl(138,60%,60%)]' : 'text-[hsl(0,0%,52%)]')}>
        <FileIcon mimeType={attachment.mimeType} size={13} />
      </span>

      {/* name + size */}
      <div className="flex flex-col leading-none">
        <span className="truncate leading-snug">{shortName}</span>
        {isError ? (
          <span className="text-[10px] text-red-400/80 leading-snug">{attachment.errorMsg ?? 'Upload failed'}</span>
        ) : (
          <span className="text-[10px] text-[hsl(0,0%,42%)] leading-snug">{sizeMb} MB</span>
        )}
      </div>

      {/* spinner or done indicator */}
      {isUploading && (
        <span className="ml-0.5 h-3 w-3 shrink-0 animate-spin rounded-full border border-[hsl(0,0%,30%)] border-t-[hsl(216,80%,60%)]" />
      )}

      {/* remove button */}
      {!isUploading && (
        <button
          type="button"
          onClick={() => onRemove(attachment.id)}
          className="ml-0.5 shrink-0 rounded p-0.5 text-[hsl(0,0%,46%)] opacity-0 transition-opacity group-hover:opacity-100 hover:text-[hsl(0,0%,78%)]"
          aria-label="Remove file"
        >
          <X size={11} />
        </button>
      )}
    </div>
  )
}

// ─── Main Composer ─────────────────────────────────────────────────────────────

export function Composer(): JSX.Element {
  const { token } = useAuth()
  const { sendMessage, stopExecution, isStreaming, activeThread, activePlan } = useChat()
  const { currentWorkspace } = useWorkspace()
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<AttachedFile[]>([])
  const [isDragOver, setIsDragOver] = useState(false)
  const [isDrawerOpen, setIsDrawerOpen] = useState(false)
  const [mode, setMode] = useState<'fast' | 'high'>('high')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const canSend = (text.trim().length > 0 || attachments.some(a => a.status === 'done'))
    && !isStreaming
    && !!activeThread
    && attachments.every(a => a.status !== 'uploading')

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 160)}px`
    }
  }, [text])

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
    if (!canSend) return
    const doneDocs = attachments.filter(a => a.status === 'done')
    const payloadAttachments = doneDocs
      .filter((a): a is AttachedFile & { fileAssetId: string; cloudinaryUrl: string } => !!a.fileAssetId && !!a.cloudinaryUrl)
      .map(a => ({
        fileAssetId: a.fileAssetId,
        cloudinaryUrl: a.cloudinaryUrl,
        mimeType: a.mimeType,
        fileName: a.name,
      }))

    sendMessage(text.trim(), payloadAttachments.length > 0 ? payloadAttachments : undefined, mode)
    setText('')
    setAttachments([])
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

  const referencedIds = new Set(attachments.map(a => a.fileAssetId).filter(Boolean) as string[])

  return (
    <div
      className="shrink-0 px-5 py-3 titlebar-no-drag"
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

      <div className="max-w-[760px] mx-auto relative">
        {isStreaming && activePlan && <PlanDrawer plan={activePlan} />}

        <div
          className={cn(
            'rounded-[20px] border shadow-[0_12px_24px_rgba(0,0,0,0.2),inset_0_1px_0_rgba(255,255,255,0.03)]',
            'bg-[linear-gradient(180deg,hsl(0,0%,9%),hsl(0,0%,7%))]',
            'transition-colors duration-150 relative z-10',
            isDragOver
              ? 'border-[hsl(216,80%,52%)] shadow-[0_0_0_2px_hsl(216,80%,42%,0.25)] '
              : activeThread
                ? 'border-[hsl(0,0%,16%)] focus-within:border-[hsl(216,14%,28%)]'
                : 'border-[hsl(0,0%,16%)] opacity-60',
          )}
        >
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
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-[20px] bg-[hsl(216,80%,10%,0.6)]">
              <span className="text-[13px] font-medium text-[hsl(216,80%,70%)]">Drop file to attach</span>
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
                  : activeThread
                    ? `Ask about ${currentWorkspace?.name ?? 'this workspace'} or run /run <command>`
                    : currentWorkspace
                      ? `Create a thread in ${currentWorkspace.name} to start`
                      : 'Open a workspace folder to start'
              }
              disabled={!activeThread}
              rows={1}
              className={cn(
                'w-full resize-none bg-transparent text-[15px] leading-6 tracking-[-0.01em]',
                'text-[hsl(0,0%,89%)] placeholder:text-[hsl(0,0%,46%)]',
                'focus:outline-none disabled:cursor-not-allowed min-h-[44px]',
              )}
            />

            <div className="mt-2.5 flex items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  disabled
                  className="inline-flex h-8 items-center gap-2 rounded-xl border border-[hsl(0,0%,24%)] bg-[hsl(0,0%,22%)] px-3 text-[13px] font-medium text-[hsl(0,0%,80%)] shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] disabled:cursor-default"
                >
                  <Infinity size={14} />
                  <span>Agent</span>
                  <ChevronDown size={13} className="text-[hsl(0,0%,60%)]" />
                </button>

                {/* ── Mode toggle ───────────────────────────────────────── */}
                <button
                  type="button"
                  disabled={!activeThread || isStreaming}
                  onClick={() => setMode(m => m === 'fast' ? 'high' : 'fast')}
                  className={cn(
                    'inline-flex h-8 items-center gap-1.5 rounded-xl border px-2.5 text-[12px] font-medium transition-all select-none',
                    !activeThread || isStreaming
                      ? 'border-transparent text-[hsl(0,0%,32%)] cursor-not-allowed'
                      : 'border-transparent bg-[hsl(0,0%,22%)] text-[hsl(0,0%,80%)] hover:bg-[hsl(0,0%,26%)]'
                  )}
                  title={mode === 'fast' ? 'Fast mode — lightweight models, lower cost' : 'High mode — flagship models, full capability'}
                >
                  {mode === 'fast' ? <Zap size={13} className="text-[hsl(43,95%,60%)]" strokeWidth={2.5} /> : <Flame size={13} className="text-[hsl(210,100%,66%)]" strokeWidth={2.5} />}
                  <span className="tracking-wide text-[13px]">{mode === 'fast' ? 'Fast' : 'High'}</span>
                  <ChevronDown size={13} className={cn(!activeThread || isStreaming ? 'text-[hsl(0,0%,32%)]' : 'text-[hsl(0,0%,56%)]')} />
                </button>
              </div>

              <div className="flex items-center gap-1.5 ml-auto">
                <button
                  type="button"
                  onClick={() => setIsDrawerOpen(true)}
                  className={cn(
                    "inline-flex h-7 min-w-[28px] px-1.5 items-center justify-center rounded-lg transition-colors gap-1",
                    referencedIds.size > 0
                      ? "bg-[hsl(216,80%,15%)] text-[hsl(216,80%,70%)] border border-[hsl(216,80%,40%)]"
                      : "text-[hsl(0,0%,48%)] hover:bg-[hsl(0,0%,21%)] hover:text-[hsl(0,0%,80%)] border border-transparent"
                  )}
                  title="Reference files"
                >
                  <AtSign size={15} />
                  {referencedIds.size > 0 && <span className="text-[11px] font-semibold pr-0.5">{referencedIds.size}</span>}
                </button>

                {/* ── File attach button (enabled) ─────────────────────────── */}
                <button
                  type="button"
                  disabled={!activeThread}
                  onClick={() => fileInputRef.current?.click()}
                  className={cn(
                    'inline-flex h-7 w-7 items-center justify-center rounded-lg transition-colors',
                    activeThread
                      ? 'text-[hsl(0,0%,58%)] hover:bg-[hsl(0,0%,19%)] hover:text-[hsl(0,0%,80%)]'
                      : 'text-[hsl(0,0%,38%)] cursor-not-allowed',
                  )}
                  title="Attach file (PDF, DOCX, image…)"
                >
                  <Paperclip size={15} />
                </button>

                {/* ── Send button ──────────────────────────────────────────── */}
                {isStreaming ? (
                  <button
                    type="button"
                    onClick={() => { void stopExecution() }}
                    className="ml-1 shrink-0 flex h-8 w-8 items-center justify-center rounded-xl border border-[hsl(0,0%,76%)] bg-[hsl(0,0%,92%)] text-[hsl(0,0%,8%)] shadow-[0_10px_24px_rgba(255,255,255,0.08)] transition-all hover:bg-[hsl(0,0%,86%)]"
                    title="Stop generation"
                  >
                    <Square size={12} fill="currentColor" />
                  </button>
                ) : (
                  <button
                    onClick={handleSend}
                    disabled={!canSend}
                    className={cn(
                      'ml-1 shrink-0 h-8 w-8 rounded-xl flex items-center justify-center border transition-all',
                      canSend
                        ? 'border-[hsl(138,67%,44%)] bg-[hsl(138,67%,48%)] text-[hsl(0,0%,7%)] shadow-[0_10px_24px_rgba(34,197,94,0.22)] hover:bg-[hsl(138,67%,45%)]'
                        : 'border-[hsl(0,0%,24%)] bg-[hsl(0,0%,24%)] text-[hsl(0,0%,38%)]',
                    )}
                  >
                    <ArrowUp size={14} />
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        <p className="mt-1.5 text-center text-[9px] tracking-[0.02em] text-[hsl(0,0%,28%)]">
          {currentWorkspace
            ? `Threads are scoped to ${currentWorkspace.name}. Drag & drop or attach PDFs, DOCX, or images.`
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
