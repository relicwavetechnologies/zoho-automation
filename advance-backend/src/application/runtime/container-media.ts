/**
 * What Divo can actually do with a file someone hands it.
 *
 * A file is streamed into the sender's own container workspace and named to the
 * agent as a path. Nothing is extracted here, so this module does not ask "can
 * the backend parse these bytes" — it asks the only question left: is there a
 * skill in the container that can open this at all.
 *
 * That inverts the usual allow-list. The container has PDF, Office, image, text
 * and archive tooling, so refusing anything not on a list of extensions would
 * refuse files it can open perfectly well. What it genuinely has no skill for is
 * a short, stable set — video and opaque binaries — so that is what is named
 * here. Recognised audio is intercepted by transcription before this classifier.
 * Everything else is staged and left to the agent.
 *
 * Channel-neutral on purpose. This used to live under `channels/lark`, which is
 * how the browser came to accept an .mp4 that a Lark DM would have refused: the
 * policy was in Lark's folder, so the web route could not reach it without
 * importing Lark. The container is the same container on both surfaces, and its
 * skills do not change with the doorway a file came through.
 */

export type ContainerMediaSupport = 'supported' | 'unsupported_document';

const AUDIO_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  wma: 'audio/x-ms-wma',
  amr: 'audio/amr',
};

/**
 * Formats no container skill can open. Recognised audio is routed to
 * transcription before it reaches here; these entries keep the fallback closed
 * if that routing is ever bypassed. Video and opaque binaries stay unreadable.
 */
const UNREADABLE_EXTENSIONS = new Set([
  'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma', 'amr',
  'mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv', 'flv', 'm4v', '3gp',
  'exe', 'dll', 'so', 'dylib', 'bin', 'dmg', 'iso', 'img', 'apk', 'msi',
]);

const UNREADABLE_MIME_PREFIXES = ['audio/', 'video/'];

const extensionOf = (fileName: string | undefined): string =>
  (fileName ?? '').toLowerCase().split('.').at(-1) ?? '';

/** The audio MIME type for a filename, or null if it is not audio we know. */
export const audioMimeType = (fileName: string | undefined): string | null =>
  AUDIO_MIME_BY_EXTENSION[extensionOf(fileName)] ?? null;

/**
 * The extension is consulted as well as the MIME type because a sender can
 * report `application/octet-stream` for anything its own table misses — a bare
 * MIME type is not enough to tell a spreadsheet from an .mp4.
 */
export const classifyContainerMedia = (attachment: {
  readonly type: 'file' | 'image';
  readonly fileName?: string;
  readonly mimeType?: string;
}): ContainerMediaSupport => {
  if (attachment.type === 'image') return 'supported';
  const mime = (attachment.mimeType ?? '').toLowerCase().split(';')[0]?.trim() ?? '';
  if (UNREADABLE_MIME_PREFIXES.some(prefix => mime.startsWith(prefix))) {
    return 'unsupported_document';
  }
  return UNREADABLE_EXTENSIONS.has(extensionOf(attachment.fileName))
    ? 'unsupported_document'
    : 'supported';
};

export const isSupportedContainerMedia = (attachment: {
  readonly type: 'file' | 'image';
  readonly fileName?: string;
  readonly mimeType?: string;
}): boolean => classifyContainerMedia(attachment) === 'supported';

/**
 * Prompt-only context for a file no skill in the container can open.
 *
 * The limit is this file's format, not the channel it arrived on, so pointing
 * the user at another surface would be wrong advice — they all reach the same
 * container, and none of them can transcribe an .mp4.
 *
 * Written as an instruction rather than a canned sentence so Divo answers in
 * its own voice and can fold the refusal into whatever else the message asked.
 * The explicit "do not guess" line matters: without it a model will happily
 * infer a meeting's contents from `standup-recording.mp4`.
 */
export const unsupportedDocumentNotice = (fileName: string): string =>
  `[File: "${fileName}" — NOT SAVED. Divo has no skill that can open this file format.\n`
  + 'Tell the user in your own words that you cannot work with this particular format. '
  + 'This audio or video format cannot be transcribed, and program binaries cannot be inspected. '
  + 'Documents, spreadsheets, images, text, and archives all work. '
  + 'Do not guess or infer anything about this file\'s contents from its name. '
  + 'Do not claim to have read it, and do not promise to read it later in this conversation.]';
