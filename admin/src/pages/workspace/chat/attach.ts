/**
 * Which files the composer will carry, and which it turns away at the door.
 *
 * The server decides this for real — it classifies every upload, refuses what no
 * container skill can open, and answers 413 on anything oversized. Nothing here
 * can loosen that, and nothing here is trusted by it. What this buys is the
 * round trip: a person who drags in a 300 MB screen recording finds out now,
 * next to the file, rather than after an upload and a model turn spent being
 * told the same thing in a paragraph.
 *
 * So the rules below are deliberately the *short, stable* half of the server's
 * policy — opaque binaries, and the video containers the server has not
 * committed to reading. Anything the browser is unsure about is accepted and
 * sent, because the classifier on the other side is the one that knows, and a
 * guess made here would refuse files that work.
 *
 * Audio and video are accepted on purpose, and neither is staged as a file.
 * Audio is transcribed and the run is handed the words, exactly as a Lark voice
 * note. Video goes to its own streaming endpoint, is watched, and the run is
 * handed what was seen and said — which is why it is measured against a much
 * larger ceiling than everything else here.
 */

/**
 * Mirrors `MAX_RUNTIME_ATTACHMENTS` in the runtime and multer's own `files`
 * limit on the route. Past this the runtime stages the first four and tells the
 * run in the prompt which ones it could not open — correct behaviour, but a
 * silent truncation to the person who attached them, so the composer stops
 * first and says so.
 */
export const MAX_FILES = 4

/**
 * Mirrors `KNOWLEDGE_FILE_MAX_MB`, which is what the route sizes multer with.
 * A deployment can set it lower; that shows up as the 413 the stream already
 * names, so this staying generous only ever costs a round trip, never a
 * wrongly refused file.
 */
export const MAX_FILE_BYTES = 24 * 1_024 * 1_024

/** What no container skill can open. The same set `container-media` refuses. */
const UNREADABLE_EXTENSIONS = new Set([
  'avi', 'mkv', 'wmv', 'flv', 'm4v', '3gp',
  'exe', 'dll', 'so', 'dylib', 'bin', 'dmg', 'iso', 'img', 'apk', 'msi',
])

/**
 * The three containers Divo reads.
 *
 * Narrower than what ffmpeg could decode, and deliberately: each one here is a
 * format the server has committed to, and the server refuses the rest by name
 * rather than accepting a file it will fail on later. `.avi` and `.mkv` stay in
 * the unreadable set above for exactly that reason.
 */
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'webm'])

/**
 * Far larger than `MAX_FILE_BYTES`, because a video does not take that path.
 *
 * An ordinary attachment rides the multipart ask and is held in memory server
 * side; a recording is streamed to its own endpoint and never is. This mirrors
 * `CONVERSATION_VIDEO_MAX_MB` — generous here costs a round trip at worst,
 * since the server counts the bytes as they arrive and stops on its own.
 */
export const MAX_VIDEO_BYTES = 2_047 * 1_024 * 1_024

const AUDIO_EXTENSIONS = new Set([
  'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma', 'amr',
])

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
}

/** How the chip draws itself. Not a claim about what the agent will do with it. */
export type FileKind = 'image' | 'audio' | 'video' | 'doc'

/**
 * Enough of a file to name it. A `File` already is one.
 *
 * Widened from `File` on purpose: the same chip is drawn twice over — once for
 * a file the composer is holding, and once for one the thread is reading back
 * out of a message sent last week, where the bytes are long gone and only the
 * description survives. Two shapes here would have meant two chips, and two
 * chips drift.
 */
export type Named = { readonly name: string; readonly type: string }

/**
 * A file that already went, as the transcript knows it.
 *
 * `outcome` is the server's word, not a guess made here: audio was heard and
 * folded into the words rather than staged, and a refused format never reached
 * the container at all. Both are still things the person attached, which is why
 * the message shows them.
 */
export type SentFile = {
  name: string
  /** The browser's mime type as it was sent. Empty when the browser had none. */
  mime: string
  bytes: number
  outcome: 'file' | 'audio' | 'refused' | 'video'
  /**
   * The bytes, while this tab still has them.
   *
   * Present only for a message sent in this session, which is exactly when a
   * real thumbnail is possible: reload the page and the transcript comes back
   * from the server with names and sizes and no content. Carried rather than a
   * pre-made object URL so the card that draws it also owns revoking it —
   * a URL minted here would outlive every card that ever showed it.
   */
  file?: File
}

export function kindOf(file: Named): FileKind {
  if (file.type.startsWith('image/')) return 'image'
  if (file.type.startsWith('audio/') || AUDIO_EXTENSIONS.has(extensionOf(file.name))) return 'audio'
  if (isVideo(file)) return 'video'
  return 'doc'
}

/** A recording Divo will watch, as opposed to a file it will open. */
export function isVideo(file: Named): boolean {
  return VIDEO_EXTENSIONS.has(extensionOf(file.name))
    || (file.type.toLowerCase().startsWith('video/') && videoMimeIsRead(file.type))
}

function videoMimeIsRead(mime: string): boolean {
  const type = mime.toLowerCase().split(';')[0]?.trim()
  return type === 'video/mp4' || type === 'video/quicktime' || type === 'video/webm'
}

/**
 * The content type to send a recording under.
 *
 * Taken from the extension when the browser offers nothing usable — a `.mov`
 * dragged from some file managers arrives with an empty type, and the upload
 * route reads the type from the header rather than the name.
 */
export function videoMimeFor(file: Named): string {
  if (videoMimeIsRead(file.type)) return file.type.toLowerCase().split(';')[0]!.trim()
  const extension = extensionOf(file.name)
  if (extension === 'mov') return 'video/quicktime'
  if (extension === 'webm') return 'video/webm'
  return 'video/mp4'
}

/** The same reading, for a file the browser no longer holds. */
export function kindOfSent(sent: SentFile): FileKind {
  return kindOf({ name: sent.name, type: sent.mime })
}

/** What the composer is holding, described the way the thread will read it back. */
export function sentFrom(file: File): SentFile {
  return {
    name: file.name,
    mime: file.type,
    bytes: file.size,
    file,
    /* Optimistic, and knowingly so. The server decides what an upload really
       became and the thread shows that answer on reload; this is the same
       message a moment earlier, when the only honest thing to say is that the
       file went. Guessing `refused` here would flash a refusal at somebody
       whose file is about to be read perfectly well. */
    outcome: isVideo(file) ? 'video' : 'file',
  }
}

/**
 * Formats nothing on the far side can read.
 *
 * Video used to be the whole of this rule. It is now the opposite — a recording
 * is watched — so what remains here is opaque binaries and the video containers
 * the server has not committed to.
 */
export function isUnopenable(file: File): boolean {
  if (kindOf(file) === 'audio') return false
  if (isVideo(file)) return false
  if (file.type.toLowerCase().startsWith('video/')) return true
  return UNREADABLE_EXTENSIONS.has(extensionOf(file.name))
}

export function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_024 * 1_024) return `${Math.round(bytes / 1_024)} KB`
  const mb = bytes / (1_024 * 1_024)
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
}

export type Rejection = { name: string; reason: string }

export type AcceptResult = {
  /** The new attachment list, in the order the files were offered. */
  files: File[]
  /** What was turned away, ready to show under the composer. */
  rejected: Rejection[]
}

/**
 * Add files to what the composer is already holding.
 *
 * One function for the picker, the paste and the drop, because the rules must
 * not depend on how a file got here — three call sites with three slightly
 * different caps is how a surface ends up accepting by drag what it refuses by
 * click.
 *
 * A duplicate is dropped silently rather than reported. Dragging the same file
 * twice is a slip, not a request, and it needs no sentence.
 */
export function acceptFiles(current: readonly File[], incoming: readonly File[]): AcceptResult {
  const files = [...current]
  const rejected: Rejection[] = []
  const seen = new Set(current.map(key))

  for (const file of incoming) {
    if (seen.has(key(file))) continue

    if (isUnopenable(file)) {
      rejected.push({ name: file.name, reason: 'Divo has no skill that can open this format' })
      continue
    }
    /* A recording is measured against its own ceiling: it is streamed to a
       different endpoint and never held in memory, so the limit that protects
       the multipart path does not apply to it. */
    const ceiling = isVideo(file) ? MAX_VIDEO_BYTES : MAX_FILE_BYTES
    if (file.size > ceiling) {
      rejected.push({ name: file.name, reason: `larger than ${formatBytes(ceiling)}` })
      continue
    }
    /* Checked per file rather than once up front, so the ones that fit are all
       kept and only the overflow is named. */
    if (files.length >= MAX_FILES) {
      rejected.push({ name: file.name, reason: `only ${MAX_FILES} files can go with one message` })
      continue
    }

    seen.add(key(file))
    files.push(file)
  }

  return { files, rejected }
}

/**
 * A pasted screenshot has no name — the clipboard calls every one of them
 * `image.png`, so four of them look like one file pasted four times.
 */
export function namedForClipboard(file: File, at: number): File {
  if (file.name && file.name !== 'image.png') return file
  const extension = extensionOf(file.name) || file.type.split('/')[1] || 'png'
  return new File([file], `pasted-${at}.${extension}`, { type: file.type })
}

/** Identity for de-duplication. Two files with one name and one size are one file. */
function key(file: File): string {
  return `${file.name}:${file.size}`
}

/** "PDF is too big" reads better than a list of one. */
export function rejectionSentence(rejected: readonly Rejection[]): string {
  if (rejected.length === 0) return ''
  if (rejected.length === 1) return `${rejected[0]!.name} — ${rejected[0]!.reason}.`
  return `${rejected.length} files were not attached: ${rejected
    .map((item) => `${item.name} (${item.reason})`)
    .join(', ')}.`
}
