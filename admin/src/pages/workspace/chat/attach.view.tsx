/**
 * Handing a file to Divo in a browser.
 *
 * Three ways in, because people already have three habits: drag it onto the
 * conversation, paste a screenshot straight into the field, or pick it from the
 * `+` menu. They all end in the same `acceptFiles`, so what is accepted never
 * depends on which one you reached for.
 *
 * The drop target is the whole conversation rather than the composer. A file is
 * being given to Divo, not typed into a box, and a 40-pixel strip at the bottom
 * of the window is a target you have to aim at — which is exactly the moment a
 * miss becomes the browser navigating away from the app to display your PDF.
 * That miss is guarded separately, at the window, because it can land anywhere.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { FileText, Image as ImageIcon, AudioLines, Clapperboard, Play, X } from 'lucide-react'
import {
  acceptFiles, formatBytes, kindOf, kindOfSent, rejectionSentence,
  type FileKind, type Rejection, type SentFile,
} from './attach'

/**
 * Stop a missed drop from replacing the app with the file.
 *
 * A browser's default for a dropped file is to open it, and "open it" means
 * leaving the page — mid-run, with a thread on screen. Registered once for the
 * whole window because a miss by definition lands outside the target.
 */
export function useDropGuard(): void {
  useEffect(() => {
    const swallow = (event: DragEvent) => {
      if (!carriesFiles(event)) return
      event.preventDefault()
    }
    window.addEventListener('dragover', swallow)
    window.addEventListener('drop', swallow)
    return () => {
      window.removeEventListener('dragover', swallow)
      window.removeEventListener('drop', swallow)
    }
  }, [])
}

export type DropProps = {
  onDragEnter: (event: React.DragEvent) => void
  onDragOver: (event: React.DragEvent) => void
  onDragLeave: (event: React.DragEvent) => void
  onDrop: (event: React.DragEvent) => void
}

/**
 * Whether a file is being dragged over this region, and the handlers that say so.
 *
 * Depth-counted rather than set-and-cleared. `dragleave` fires every time the
 * pointer crosses into a child element, so the naive version flickers the whole
 * time you move across a conversation — which reads as the target refusing the
 * file. Counting entries against leaves means only leaving the region itself
 * turns it off.
 */
export function useFileDrop(onFiles: (files: File[]) => void): {
  over: boolean
  dropProps: DropProps
} {
  const [over, setOver] = useState(false)
  const depth = useRef(0)

  const onDragEnter = useCallback((event: React.DragEvent) => {
    if (!carriesFiles(event.nativeEvent)) return
    event.preventDefault()
    depth.current += 1
    setOver(true)
  }, [])

  const onDragOver = useCallback((event: React.DragEvent) => {
    if (!carriesFiles(event.nativeEvent)) return
    // Without this the drop never fires at all — the default is to reject it.
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }, [])

  const onDragLeave = useCallback((event: React.DragEvent) => {
    if (!carriesFiles(event.nativeEvent)) return
    depth.current = Math.max(0, depth.current - 1)
    if (depth.current === 0) setOver(false)
  }, [])

  const onDrop = useCallback((event: React.DragEvent) => {
    if (!carriesFiles(event.nativeEvent)) return
    event.preventDefault()
    depth.current = 0
    setOver(false)
    const dropped = Array.from(event.dataTransfer.files ?? [])
    if (dropped.length > 0) onFiles(dropped)
  }, [onFiles])

  return { over, dropProps: { onDragEnter, onDragOver, onDragLeave, onDrop } }
}

/**
 * Text and links are dragged around a page constantly; a highlighted selection
 * pulled across the thread must not look like an upload about to happen.
 */
function carriesFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files')
}

/**
 * What a region looks like while a file is over it.
 *
 * Drawn on top of the conversation rather than replacing it, and translucent, so
 * the thread stays legible underneath — the answer being read is often the
 * reason the file is being dragged in.
 */
export function DropVeil({ visible }: { visible: boolean }) {
  if (!visible) return null
  return (
    <div
      className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-veil p-4"
    >
      <div
        className="flex flex-col items-center gap-2 rounded-card border border-dashed px-8 py-6"
        style={{ borderColor: 'var(--bui-line-strong)', background: 'var(--bui-surface)' }}
      >
        <span className="text-[13px] font-medium text-ink">Drop to attach</span>
        <span className="text-[12px] text-ink-3">Divo saves it to this chat&rsquo;s workspace</span>
      </div>
    </div>
  )
}

const ICON = {
  image: ImageIcon, audio: AudioLines, video: Clapperboard, doc: FileText,
} as const

/** What each kind is called, when the size is not the useful thing to say. */
const KIND_LABEL: Record<FileKind, string> = {
  image: 'Image',
  audio: 'Audio',
  video: 'Video',
  doc: 'File',
}

/**
 * The files this message will carry, above the field they were attached to.
 *
 * Named and sized rather than shown as thumbnails. A thumbnail answers "which
 * picture is this", which the person already knows, and costs a decoded image
 * per chip; the name is what they will refer to in the sentence they are about
 * to type.
 */
export function FileChips({
  files, onRemove,
}: {
  files: readonly File[]
  onRemove: (index: number) => void
}) {
  if (files.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5 px-1 pb-1.5">
      {files.map((file, index) => (
        <FileCard
          key={`${file.name}:${file.size}`}
          name={file.name}
          kind={kindOf(file)}
          bytes={file.size}
          file={file}
        >
          <button
            type="button"
            aria-label={`Remove ${file.name}`}
            onClick={(event) => { event.stopPropagation(); onRemove(index) }}
            className="flex size-5 shrink-0 items-center justify-center rounded-full text-ink-3 transition-colors duration-100 hover:bg-surface hover:text-ink"
          >
            <X size={11} />
          </button>
        </FileCard>
      ))}
    </div>
  )
}

/**
 * The files a message went with, under the message.
 *
 * Same chip as the composer's, deliberately: what somebody saw themselves
 * attach is what they should recognise in their own message afterwards, and a
 * second chip drawn from a second description is how the two stop matching.
 * Right-aligned because the ask is.
 *
 * A file nothing could be done with is still shown, dimmed and said so. It is
 * the one a reader comes back puzzled about, and a transcript that quietly drops
 * it answers the puzzle with silence.
 */
export function SentChips({ files }: { files: readonly SentFile[] }) {
  if (files.length === 0) return null
  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      {files.map((file) => (
        <FileCard
          key={`${file.name}:${file.bytes}`}
          name={file.name}
          kind={kindOfSent(file)}
          bytes={file.bytes}
          {...(file.file ? { file: file.file } : {})}
          muted={file.outcome === 'refused'}
          note={noteFor(file)}
        />
      ))}
    </div>
  )
}

/**
 * What to say under the name, when the size is not the interesting part.
 *
 * A refusal and a transcription are both things that happened *to* the file
 * after it left, and a reader coming back to the message wants to know which —
 * "2.4 MB" is true and answers nothing.
 */
function noteFor(file: SentFile): string | undefined {
  if (file.outcome === 'refused') return 'Not readable'
  if (file.outcome === 'audio') return 'Audio · transcribed'
  return undefined
}

/**
 * One file, shown as itself wherever it appears.
 *
 * A pill with an icon in it was the same drawing for a screenshot, a contract
 * and a two-minute screen recording — three things a reader tells apart
 * instantly by *looking*, reduced to three identical rounded rectangles whose
 * only distinguishing mark was a filename they had to read.
 *
 * So the tile leads, and it shows the thing itself when the thing can be shown:
 * the actual image, the recording's own first frame. That is possible only
 * while this tab still holds the bytes — a transcript re-read after a reload
 * comes back from the server as names and sizes — so the typed tile is not a
 * fallback for failure, it is the ordinary case for anything not sent just now.
 *
 * One component for the composer and the transcript, because what somebody
 * watched themselves attach is what they should recognise in their own message
 * afterwards, and two drawings from two descriptions is how those drift apart.
 */
export function FileCard({ name, kind, bytes, file, muted, note, children }: {
  name: string
  kind: FileKind
  bytes: number
  /** The bytes, when this tab still has them. Enables a real preview. */
  file?: File
  muted?: boolean
  /** Replaces the size when there is something more worth saying than how big it is. */
  note?: string
  children?: React.ReactNode
}) {
  const Icon = ICON[kind]
  const preview = usePreviewUrl(file, kind)
  return (
    <span
      className={`flex max-w-[240px] items-center gap-2 rounded-xl bg-fill p-1.5 text-[12px] ${
        children ? 'pr-1' : 'pr-2.5'
      } ${muted ? 'text-ink-3' : 'text-ink'}`}
      style={{ animation: 'bui-pop-in 160ms cubic-bezier(0.23,1,0.32,1) both' }}
    >
      <span className="relative grid size-9 shrink-0 place-items-center overflow-hidden rounded-lg bg-surface">
        {preview && kind === 'image' ? (
          <img src={preview} alt="" className="size-full object-cover" />
        ) : preview && kind === 'video' ? (
          <>
            {/* `preload="metadata"` is what paints the first frame without
                fetching the whole recording — a two-gigabyte file would
                otherwise be pulled into memory to draw a 36-pixel square. */}
            <video src={preview} preload="metadata" muted playsInline className="size-full object-cover" />
            <span className="absolute inset-0 grid place-items-center bg-black/25 text-white">
              <Play size={11} fill="currentColor" strokeWidth={0} />
            </span>
          </>
        ) : (
          <Icon size={15} className="text-ink-3" />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate">{name}</span>
        <span className="truncate text-[11px] text-ink-3">
          {note ?? `${KIND_LABEL[kind]} · ${formatBytes(bytes)}`}
        </span>
      </span>
      {children}
    </span>
  )
}

/**
 * An object URL for as long as the card that uses it is on screen.
 *
 * Minted and revoked here rather than where the file was picked up: a URL made
 * at send time outlives every card that ever drew it, and nothing at that point
 * knows when the last one goes away. Only kinds that can actually be shown get
 * one — there is no sense allocating a handle to a PDF nobody will render.
 */
function usePreviewUrl(file: File | undefined, kind: FileKind): string | null {
  const showable = Boolean(file) && (kind === 'image' || kind === 'video')
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!file || !showable) {
      setUrl(null)
      return
    }
    const created = URL.createObjectURL(file)
    setUrl(created)
    return () => {
      URL.revokeObjectURL(created)
      setUrl(null)
    }
  }, [file, showable])
  return url
}

/**
 * Why a file did not attach, under the composer.
 *
 * It clears itself. A refusal is about the drop that just happened, and one left
 * sitting there while somebody types their next message reads as a complaint
 * about that message instead.
 */
export function RejectionNote({ rejected }: { rejected: readonly Rejection[] }) {
  const sentence = rejectionSentence(rejected)
  if (!sentence) return null
  return (
    <p className="px-3 pt-1.5 text-[11.5px] text-ink-3" role="status">
      {sentence}
    </p>
  )
}

/**
 * The composer's attachment state, held where the screen can clear it on send.
 *
 * A hook rather than three `useState`s in each screen, because Home and the
 * thread both compose and both had to agree on the clearing rules — including
 * the timer, which is the part that is easy to leave out and never notice.
 */
export function useAttachments(): {
  files: File[]
  rejected: Rejection[]
  add: (incoming: readonly File[]) => void
  remove: (index: number) => void
  clear: () => void
} {
  const [files, setFiles] = useState<File[]>([])
  const [rejected, setRejected] = useState<Rejection[]>([])
  const timer = useRef<number | undefined>(undefined)
  /* The list as of *now*, not as of the last render. `add` is reached from a
     drop handler and a paste handler that can both fire before React has
     re-rendered, and reading state there would let the second one decide
     against a list the first has already added to — which is how a fifth file
     gets past a cap of four. Deciding inside a `setFiles` updater would fix the
     staleness and break something worse: the rejection notice is a side effect,
     and StrictMode runs updaters twice. */
  const held = useRef<File[]>(files)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  const commit = useCallback((next: File[]) => {
    held.current = next
    setFiles(next)
  }, [])

  const add = useCallback((incoming: readonly File[]) => {
    const result = acceptFiles(held.current, incoming)
    commit(result.files)
    setRejected(result.rejected)
    window.clearTimeout(timer.current)
    if (result.rejected.length > 0) {
      timer.current = window.setTimeout(() => setRejected([]), 6_000)
    }
  }, [commit])

  const remove = useCallback((index: number) => {
    commit(held.current.filter((_, at) => at !== index))
  }, [commit])

  const clear = useCallback(() => {
    window.clearTimeout(timer.current)
    commit([])
    setRejected([])
  }, [commit])

  return { files, rejected, add, remove, clear }
}
