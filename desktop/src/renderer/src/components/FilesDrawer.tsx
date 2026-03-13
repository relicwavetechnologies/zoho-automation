import { useState, useEffect, useCallback } from 'react'
import { X, FileText, Image as ImageIcon, File, Clock, Shield, Trash2, Loader2, RotateCcw, Share2 } from 'lucide-react'
import { cn } from '../lib/utils'
import { useAuth } from '../context/AuthContext'

export type FileAssetRecord = {
  id: string
  fileName: string
  mimeType: string
  sizeBytes: number
  cloudinaryUrl: string
  ingestionStatus: string
  ingestionError?: string | null
  createdAt: string
  accessPolicies: Array<{ aiRole: string }>
  shareStatus?: string
  shareSummary?: string
  sharedCompanyWide?: boolean
}

interface FilesDrawerProps {
  open: boolean
  onClose: () => void
  onReference: (file: FileAssetRecord) => void
  referencedIds: Set<string>
}

function FileTypeIcon({ mimeType }: { mimeType: string }) {
  if (mimeType.startsWith('image/')) return <ImageIcon size={14} className="text-blue-400" />
  if (mimeType === 'application/pdf') return <FileText size={14} className="text-red-400" />
  return <File size={14} className="text-slate-400" />
}

function ingestionLabel(status: string) {
  if (status === 'done') return { text: 'Indexed', cls: 'text-emerald-400' }
  if (status === 'processing') return { text: 'Processing…', cls: 'text-amber-400' }
  if (status === 'failed') return { text: 'Failed', cls: 'text-red-400' }
  return { text: 'Pending', cls: 'text-slate-500' }
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function shareLabel(status?: string, sharedCompanyWide?: boolean) {
  if (sharedCompanyWide) return { text: 'Shared', cls: 'text-emerald-400' }
  if (status === 'pending') return { text: 'Pending approval', cls: 'text-amber-400' }
  if (status === 'delivery_failed') return { text: 'Delivery failed', cls: 'text-orange-400' }
  if (status === 'reverted') return { text: 'Reverted', cls: 'text-zinc-400' }
  return null
}

export function FilesDrawer({ open, onClose, onReference, referencedIds }: FilesDrawerProps) {
  const { token } = useAuth()
  const [files, setFiles] = useState<FileAssetRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set())
  const [retryingIds, setRetryingIds] = useState<Set<string>>(new Set())
  const [sharingIds, setSharingIds] = useState<Set<string>>(new Set())
  const [canShare, setCanShare] = useState(false)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)

  const loadFiles = useCallback(async () => {
    if (!token) return
    setLoading(true)
    try {
      const result = await window.desktopAPI.files.list(token)
      if (result.success) {
        const payload = result.data as { data?: { files?: FileAssetRecord[]; canShare?: boolean } }
        setFiles(payload?.data?.files ?? [])
        setCanShare(Boolean(payload?.data?.canShare))
      }
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => {
    if (open) loadFiles()
  }, [open, loadFiles])

  useEffect(() => {
    if (!open) return undefined
    const hasInFlightFiles = files.some(
      (file) => file.ingestionStatus === 'pending' || file.ingestionStatus === 'processing',
    )
    if (!hasInFlightFiles) return undefined

    const interval = window.setInterval(() => {
      void loadFiles()
    }, 2500)

    return () => window.clearInterval(interval)
  }, [files, loadFiles, open])

  const handleDelete = useCallback(async (e: React.MouseEvent, fileId: string) => {
    e.stopPropagation()
    if (!token) return

    setDeletingIds(prev => {
      const next = new Set(prev)
      next.add(fileId)
      return next
    })

    try {
      const result = await window.desktopAPI.files.delete(token, fileId)
      if (result.success) {
        setFiles(prev => prev.filter(f => f.id !== fileId))
        if (referencedIds.has(fileId)) {
          // If it's referenced, removing it from our reference set happens automatically 
          // via Composer when the file disappears, or we might need Composer to sync.
          // For now, it just deletes from the backend. The next reload would clear it.
        }
      } else {
        console.error('Failed to delete:', result.data)
      }
    } finally {
      setDeletingIds(prev => {
        const next = new Set(prev)
        next.delete(fileId)
        return next
      })
    }
  }, [token, referencedIds])

  const handleRetry = useCallback(async (e: React.MouseEvent, fileId: string) => {
    e.stopPropagation()
    if (!token) return

    setRetryingIds(prev => {
      const next = new Set(prev)
      next.add(fileId)
      return next
    })

    try {
      const result = await window.desktopAPI.files.retry(token, fileId)
      if (result.success) {
        setFiles(prev => prev.map(f => f.id === fileId ? { ...f, ingestionStatus: 'pending' } : f))
      } else {
        console.error('Failed to retry:', result.data)
      }
    } finally {
      setRetryingIds(prev => {
        const next = new Set(prev)
        next.delete(fileId)
        return next
      })
    }
  }, [token])

  const handleShare = useCallback(async (e: React.MouseEvent, fileId: string) => {
    e.stopPropagation()
    if (!token) return

    setStatusMessage(null)
    setSharingIds(prev => {
      const next = new Set(prev)
      next.add(fileId)
      return next
    })

    try {
      const result = await window.desktopAPI.files.share(token, fileId)
      const payload = result.data as { message?: string; data?: { status?: string; classification?: string } }
      if (result.success) {
        const status = payload?.data?.status ?? 'processed'
        const classification = payload?.data?.classification
        setStatusMessage(
          classification
            ? `Share ${status.replace(/_/g, ' ')} (${classification}).`
            : `Share ${status.replace(/_/g, ' ')}.`
        )
      } else {
        setStatusMessage(payload?.message ?? 'Failed to share file.')
      }
      void loadFiles()
    } finally {
      setSharingIds(prev => {
        const next = new Set(prev)
        next.delete(fileId)
        return next
      })
    }
  }, [loadFiles, token])

  const filtered = files.filter((f) =>
    f.fileName.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <>
      {/* Backdrop */}
      {open && (
        <div
          className="fixed inset-0 z-40"
          style={{ background: 'rgba(0,0,0,0.3)' }}
          onClick={onClose}
        />
      )}

      {/* Drawer Panel */}
      <div
        className={cn(
          'fixed left-1/2 bottom-[84px] z-50 w-full max-w-[760px] -translate-x-1/2 transition-all duration-200 ease-out flex flex-col',
          open ? 'opacity-100 translate-y-0 scale-100' : 'opacity-0 translate-y-4 scale-[0.97] pointer-events-none',
          'rounded-[20px] border shadow-[0_16px_40px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.03)]',
          'border-[hsl(0,0%,16%)] bg-[linear-gradient(180deg,hsl(0,0%,11%),hsl(0,0%,9%))]',
        )}
        style={{ maxHeight: 'min(420px, 60vh)' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-3.5 pt-2.5 pb-2 border-b border-[hsl(0,0%,16%)]">
          <span className="text-[12px] font-semibold tracking-wide text-[hsl(0,0%,75%)] uppercase ml-1">File Library</span>
          <button onClick={onClose} className="rounded-md p-1.5 text-[hsl(0,0%,46%)] hover:bg-[hsl(0,0%,16%)] hover:text-[hsl(0,0%,90%)] transition-colors">
            <X size={12} />
          </button>
        </div>

        {/* Search */}
        <div className="px-3 pt-3 pb-1.5">
          <input
            type="text"
            placeholder="Search files…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className={cn(
              'w-full rounded-xl px-3 h-[32px] text-[12.5px] outline-none transition-colors leading-relaxed',
              'bg-[hsl(0,0%,14%)] text-[hsl(0,0%,90%)] placeholder-[hsl(0,0%,46%)]',
              'border border-[hsl(0,0%,20%)] focus:border-[hsl(216,80%,52%)]'
            )}
          />
        </div>

        {statusMessage && (
          <div className="mx-3 mt-1 rounded-xl border border-[hsl(0,0%,16%)] bg-[hsl(0,0%,8%)] px-3 py-2 text-[11px] text-[hsl(0,0%,68%)]">
            {statusMessage}
          </div>
        )}

        {/* File list */}
        <div className="overflow-y-auto flex-1 px-3 pb-3 space-y-1 mt-1">
          {loading && (
            <div className="flex items-center justify-center py-6">
              <div className="w-3.5 h-3.5 rounded-full border-[1.5px] border-[hsl(0,0%,30%)] border-t-[hsl(216,80%,60%)] animate-spin" />
            </div>
          )}
          {!loading && filtered.length === 0 && (
            <div className="text-center py-6 text-[12px] text-[hsl(0,0%,46%)]">
              {files.length === 0 ? 'No files uploaded yet' : 'No files match your search'}
            </div>
          )}
          {filtered.map((file) => {
            const isReferenced = referencedIds.has(file.id)
            const label = ingestionLabel(file.ingestionStatus)
            const share = shareLabel(file.shareStatus, file.sharedCompanyWide)
            const canTriggerShare =
              canShare
              && file.ingestionStatus === 'done'
              && !file.sharedCompanyWide
              && file.shareStatus !== 'pending'
            return (
              <div
                key={file.id}
                className={cn(
                  'group flex items-center gap-2.5 rounded-xl px-2.5 py-1.5 cursor-pointer transition-all duration-150 border',
                  isReferenced
                    ? 'border-[hsl(216,80%,45%)] bg-[hsl(216,80%,15%)]'
                    : 'border-transparent hover:bg-[hsl(0,0%,16%)]'
                )}
                onClick={() => onReference(file)}
              >
                <div className="flex-shrink-0 w-8 h-8 md:w-10 md:h-10 rounded-lg flex items-center justify-center bg-[hsl(0,0%,15%)] border border-[hsl(0,0%,20%)] text-[hsl(0,0%,70%)] overflow-hidden">
                  {file.mimeType.startsWith('image/') && file.cloudinaryUrl ? (
                    <img src={file.cloudinaryUrl} alt={file.fileName} className="w-full h-full object-cover" />
                  ) : (
                    <FileTypeIcon mimeType={file.mimeType} />
                  )}
                </div>
                <div className="flex-1 min-w-0 flex flex-col justify-center">
                  <p className="text-[12.5px] font-medium leading-none text-[hsl(0,0%,88%)] truncate">{file.fileName}</p>
                  <div className="flex items-center gap-1.5 mt-1 whitespace-nowrap overflow-hidden">
                    <span className={cn('text-[10px] leading-none', label.cls)}>{label.text}</span>
                    <span className="text-[hsl(0,0%,30%)] text-[10px]">·</span>
                    <span className="text-[10px] leading-none text-[hsl(0,0%,50%)]">{formatBytes(file.sizeBytes)}</span>
                    <span className="text-[hsl(0,0%,30%)] text-[10px]">·</span>
                    <span className="text-[10px] leading-none text-[hsl(0,0%,50%)] flex items-center gap-1">
                      <Clock size={9} className="text-[hsl(0,0%,40%)]" /> {formatDate(file.createdAt)}
                    </span>
                  </div>
                  {file.accessPolicies.length > 0 && (
                    <div className="flex items-center gap-1.5 mt-1 overflow-hidden">
                      <Shield size={9} className="text-[hsl(0,0%,40%)] shrink-0" />
                      <div className="flex gap-1 overflow-hidden">
                        {file.accessPolicies.map((p, idx) => (
                           <span key={idx} className="bg-[hsl(0,0%,17%)] border border-[hsl(0,0%,24%)] text-[10px] leading-none font-medium text-[hsl(0,0%,66%)] px-1 py-0.5 rounded-[4px] truncate max-w-[80px]">
                             {p.aiRole}
                           </span>
                        ))}
                      </div>
                    </div>
                  )}
                  {share && (
                    <div className="flex items-center gap-1.5 mt-1 overflow-hidden">
                      <Share2 size={9} className="text-[hsl(0,0%,40%)] shrink-0" />
                      <span className={cn('text-[10px] leading-none font-medium', share.cls)}>
                        {share.text}
                      </span>
                    </div>
                  )}
                  {file.ingestionStatus === 'failed' && file.ingestionError && (
                    <p className="mt-1 text-[10px] leading-snug text-red-400/80 line-clamp-2">
                      {file.ingestionError}
                    </p>
                  )}
                </div>
                {/* Trailing Indicators */}
                <div className="flex items-center gap-2 ml-2">
                  {isReferenced && (
                    <div className="flex-shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-[hsl(216,80%,20%)] text-[hsl(216,80%,70%)]">
                      Added
                    </div>
                  )}

                  {file.ingestionStatus === 'failed' && (
                    retryingIds.has(file.id) ? (
                      <Loader2 className="w-4 h-4 text-[hsl(0,0%,46%)] animate-spin" />
                    ) : (
                      <button
                        onClick={(e) => handleRetry(e, file.id)}
                        className="opacity-0 group-hover:opacity-100 transition-opacity p-1.5 rounded-md hover:bg-[hsl(0,0%,24%)] text-[hsl(0,0%,46%)] hover:text-blue-400"
                        title="Retry indexing"
                      >
                        <RotateCcw size={14} />
                      </button>
                    )
                  )}

                  {canTriggerShare && (
                    sharingIds.has(file.id) ? (
                      <Loader2 className="w-4 h-4 text-[hsl(0,0%,46%)] animate-spin" />
                    ) : (
                      <button
                        onClick={(e) => handleShare(e, file.id)}
                        className="opacity-0 group-hover:opacity-100 transition-opacity p-1.5 rounded-md hover:bg-[hsl(0,0%,24%)] text-[hsl(0,0%,46%)] hover:text-emerald-400"
                        title="Share to company knowledge"
                      >
                        <Share2 size={14} />
                      </button>
                    )
                  )}

                  {deletingIds.has(file.id) ? (
                    <Loader2 className="w-4 h-4 text-[hsl(0,0%,46%)] animate-spin" />
                  ) : (
                    <button
                      onClick={(e) => handleDelete(e, file.id)}
                      className="opacity-0 group-hover:opacity-100 transition-opacity p-1.5 rounded-md hover:bg-[hsl(0,0%,24%)] text-[hsl(0,0%,46%)] hover:text-red-400"
                      title="Delete file"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </>
  )
}
