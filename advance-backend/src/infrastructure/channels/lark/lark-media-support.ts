/**
 * What Divo can actually do with a Lark attachment.
 *
 * A file sent in Lark is streamed into the sender's own container workspace
 * and named to the agent as a path. Nothing is extracted here, so this module
 * no longer asks "can the backend parse these bytes" — it asks the only
 * question left: is there a skill in the container that can open this at all.
 *
 * That inverts the old allow-list. The container has PDF, Office, image, text
 * and archive tooling, so refusing anything not on a list of extensions would
 * refuse files it can open perfectly well. What it genuinely has no skill for
 * is a short, stable set — audio, video, and opaque binaries — so that is what
 * is named here. Everything else is staged and left to the agent.
 */

import type { GroupChatAttachmentContext } from '../../../domain/conversation/group-context';

export type LarkMediaSupport = 'supported' | 'unsupported_document';

/**
 * Formats no container skill can open. Audio and video would need
 * transcription Divo does not have; the rest are opaque binaries whose bytes
 * carry nothing a reader could recover.
 */
const UNREADABLE_EXTENSIONS = new Set([
  'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma', 'amr',
  'mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv', 'flv', 'm4v', '3gp',
  'exe', 'dll', 'so', 'dylib', 'bin', 'dmg', 'iso', 'img', 'apk', 'msi',
]);

const UNREADABLE_MIME_PREFIXES = ['audio/', 'video/'];

const extensionOf = (fileName: string | undefined): string =>
  (fileName ?? '').toLowerCase().split('.').at(-1) ?? '';

/**
 * The extension is consulted as well as the MIME type because Lark reports
 * `application/octet-stream` for anything its own table misses — a bare MIME
 * type is not enough to tell a spreadsheet from an .mp4.
 */
export const classifyLarkMedia = (attachment: {
  readonly type: 'file' | 'image';
  readonly fileName?: string;
  readonly mimeType?: string;
}): LarkMediaSupport => {
  if (attachment.type === 'image') return 'supported';
  const mime = (attachment.mimeType ?? '').toLowerCase().split(';')[0]?.trim() ?? '';
  if (UNREADABLE_MIME_PREFIXES.some(prefix => mime.startsWith(prefix))) {
    return 'unsupported_document';
  }
  return UNREADABLE_EXTENSIONS.has(extensionOf(attachment.fileName))
    ? 'unsupported_document'
    : 'supported';
};

export const isSupportedLarkMedia = (attachment: {
  readonly type: 'file' | 'image';
  readonly fileName?: string;
  readonly mimeType?: string;
}): boolean => classifyLarkMedia(attachment) === 'supported';

/**
 * Pixels are carried for the current turn only, never persisted, so the byte
 * cap bounds one prompt rather than a database row. Most Lark screenshots land
 * well under this.
 */
export const MAX_INLINE_IMAGE_BYTES = 4 * 1_024 * 1_024;

/**
 * Prompt-only context for a file no skill in the container can open.
 *
 * The limit is this file's format, not Lark and not the channel, so pointing
 * the user at the desktop app would be wrong advice — it reaches the same
 * container and cannot transcribe an .mp4 either.
 *
 * Written as an instruction rather than a canned sentence so Divo answers in
 * its own voice and can fold the refusal into whatever else the message asked.
 * The explicit "do not guess" line matters: without it a model will happily
 * infer a meeting's contents from `standup-recording.mp4`.
 */
export const unsupportedDocumentNotice = (fileName: string): string =>
  `[File: "${fileName}" — NOT SAVED. Divo has no skill that can open this file format.\n`
  + 'Tell the user in your own words that you cannot work with this particular format. '
  + 'Audio and video cannot be transcribed, and program binaries cannot be inspected. '
  + 'Documents, spreadsheets, images, text, and archives all work. '
  + 'Do not guess or infer anything about this file\'s contents from its name. '
  + 'Do not claim to have read it, and do not promise to read it later in this conversation.]';

/**
 * Whether this message is an attachment with nothing asked of it yet.
 *
 * People send the picture first and say what they want about it second. Those
 * are two Lark messages but one request, and answering the first produces the
 * only reply that is guaranteed to be useless — Divo has been shown something
 * and asked nothing. Worse, it burns a turn and a model call to say so.
 *
 * Only for direct messages. In a group Divo answers when addressed, so an
 * image posted without a mention already stays quiet, and an image posted
 * *with* one is a deliberate request that deserves an answer.
 */
export const isAwaitingItsQuestion = (input: {
  readonly chatType: string;
  readonly text: string | undefined;
  readonly supportedAttachmentCount: number;
  readonly unsupportedAttachmentCount: number;
}): boolean =>
  input.chatType === 'p2p'
  && input.supportedAttachmentCount > 0
  // An unreadable format is refused now, never later: no follow-up question
  // can make a .zip readable, so waiting for one would leave the user with no
  // answer at all rather than with an honest refusal.
  && input.unsupportedAttachmentCount === 0
  && !(input.text ?? '').trim();

/**
 * Prompt-only context for a document someone quote-replied to.
 *
 * The file is not re-fetched and not re-sent. It was streamed into this user's
 * workspace when it was posted, so it is still sitting there under
 * `.divo/inbox` — the notice's job is to send the agent to look for it rather
 * than to reproduce anything about it here.
 *
 * The "do not answer from the filename" line is doing real work: a quote-reply
 * is usually a short question like "what does this say", and a model holding a
 * filename and no content will answer it anyway.
 */
export const quotedDocumentNotice = (fileName: string): string =>
  `[Quoted document: "${fileName}".\n`
  + 'This file was saved to your workspace when it was posted. Find it under '
  + '`.divo/inbox` — the newest match for this filename is the one being quoted — '
  + 'and open it to answer. '
  + 'If it is not there, say you no longer have the file and ask for it again. '
  + 'Never answer from the filename alone.]';

/**
 * Prompt context for an image that was attached but could not be prepared.
 *
 * Without this the model is handed nothing at all and says "I don't see any
 * image" — which is both wrong and unhelpful, because the user is looking at
 * the image they just sent. "I could not open it, resend it" is actionable.
 */
export const unreadableImageNotice = (fileName: string, reason?: string): string =>
  `[Image: "${fileName}" — attached but could not be read${reason ? ` (${reason})` : ''}.\n`
  + 'Tell the user you could not open the image and ask them to send it again. '
  + 'Do not tell them no image was attached — one was.]';
