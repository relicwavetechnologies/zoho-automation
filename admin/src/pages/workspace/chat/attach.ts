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
 * policy — video and opaque binaries, which is the set the container has no
 * skill for and is not going to grow. Anything the browser is unsure about is
 * accepted and sent, because the classifier on the other side is the one that
 * knows, and a guess made here would refuse files that work.
 *
 * Audio is accepted on purpose. It is not staged as a file: the backend
 * transcribes it and hands the run the words, exactly as a Lark voice note.
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
  'mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv', 'flv', 'm4v', '3gp',
  'exe', 'dll', 'so', 'dylib', 'bin', 'dmg', 'iso', 'img', 'apk', 'msi',
])

const AUDIO_EXTENSIONS = new Set([
  'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma', 'amr',
])

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
}

/** How the chip draws itself. Not a claim about what the agent will do with it. */
export type FileKind = 'image' | 'audio' | 'doc'

export function kindOf(file: File): FileKind {
  if (file.type.startsWith('image/')) return 'image'
  if (file.type.startsWith('audio/') || AUDIO_EXTENSIONS.has(extensionOf(file.name))) return 'audio'
  return 'doc'
}

/** Video and binaries only — see the note at the top about not out-guessing the server. */
export function isUnopenable(file: File): boolean {
  if (kindOf(file) === 'audio') return false
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
    if (file.size > MAX_FILE_BYTES) {
      rejected.push({ name: file.name, reason: `larger than ${formatBytes(MAX_FILE_BYTES)}` })
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
