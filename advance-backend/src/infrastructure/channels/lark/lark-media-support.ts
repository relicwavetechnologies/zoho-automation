/**
 * What Divo can actually do with a Lark attachment.
 *
 * Images are downloaded for the turn, OCR'd, shown to the model, and then
 * forgotten. Documents are downloaded, excerpted inline for the current turn,
 * and queued for indexing so later questions can retrieve the parts the
 * excerpt left out.
 *
 * Support is decided by whether an extractor can actually read the bytes, not
 * by whether the file arrived. `extractFromBuffer` falls back to
 * `decodeTextBuffer` for anything it does not recognise, which turns a .zip
 * into pages of mojibake and indexes it as if it were prose. The allow-list
 * below is what keeps that out of the vector store.
 */

import type { GroupChatAttachmentContext } from '../../../domain/conversation/group-context';

export type LarkMediaSupport = 'supported' | 'unsupported_document';

/**
 * Extensions with a real extractor behind them — see `text-extraction/extract`.
 * Kept in sync with that dispatch by `lark-media-support.test`.
 */
const READABLE_DOCUMENT_EXTENSIONS = new Set([
  'pdf',
  'docx', 'doc',
  'xlsx', 'xls',
  'csv', 'tsv',
  'html', 'htm',
  'txt', 'md', 'json',
]);

const READABLE_DOCUMENT_MIMES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/csv', 'text/tab-separated-values', 'text/tsv',
  'text/html', 'application/xhtml+xml',
  'text/plain', 'text/markdown', 'application/json',
]);

const extensionOf = (fileName: string | undefined): string =>
  (fileName ?? '').toLowerCase().split('.').at(-1) ?? '';

/**
 * The extension is consulted as well as the MIME type because Lark reports
 * `application/octet-stream` for anything the parser's own table misses, and a
 * readable PDF should not be refused over a missing content type.
 */
export const classifyLarkMedia = (attachment: {
  readonly type: 'file' | 'image';
  readonly fileName?: string;
  readonly mimeType?: string;
}): LarkMediaSupport => {
  if (attachment.type === 'image') return 'supported';
  const mime = (attachment.mimeType ?? '').toLowerCase().split(';')[0]?.trim() ?? '';
  if (READABLE_DOCUMENT_MIMES.has(mime)) return 'supported';
  return READABLE_DOCUMENT_EXTENSIONS.has(extensionOf(attachment.fileName))
    ? 'supported'
    : 'unsupported_document';
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
 * Prompt-only context for a file format Divo has no extractor for.
 *
 * PDFs, Office documents and text formats are read; this covers what is left —
 * archives, executables, audio, video, and anything else whose bytes would
 * decode into noise. The distinction matters in the wording: the limit is this
 * file's format, not Lark, so pointing the user at the desktop app would be
 * wrong advice — it cannot read a .zip either.
 *
 * Written as an instruction rather than a canned sentence so Divo answers in
 * its own voice and can fold the refusal into whatever else the message asked.
 * The explicit "do not guess" line matters: without it a model will happily
 * infer a quarterly report's contents from `Q3-report.zip`.
 */
export const unsupportedDocumentNotice = (fileName: string): string =>
  `[File: "${fileName}" — NOT READ. Divo has no reader for this file format.\n`
  + 'Tell the user in your own words that you cannot open this particular format. '
  + 'Say which formats do work: PDF, Word, Excel, CSV, HTML, and plain text or Markdown. '
  + 'If it might be an archive, suggest sending the file inside it directly. '
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
 * Prompt-only context for a readable document someone quote-replied to.
 *
 * The document itself is not re-fetched here. It was indexed when it arrived,
 * and the transcript for this room carries its `fileAssetId` on the very
 * message being quoted — so this notice's job is to send the model there
 * rather than to duplicate the content inline.
 *
 * The "do not answer from the filename" line is doing real work: a quote-reply
 * is usually a short question like "what does this say", and a model holding a
 * filename and no content will answer it anyway.
 */
export const quotedDocumentNotice = (fileName: string): string =>
  `[Quoted document: "${fileName}".\n`
  + 'The user is asking about this file. It has been read and indexed. '
  + 'If the transcript above carries an internal attachment context for it with a fileAssetId, '
  + 'call contextSearch with that fileAssetId. '
  + `Otherwise call contextSearch with "${fileName}" as the query — a direct message keeps no such `
  + 'transcript, so the absence of a fileAssetId does not mean the file is missing. '
  + 'If the transcript already holds an inline excerpt of this file, answer from that first and '
  + 'search only for what it does not cover. '
  + 'Only after a search comes back empty should you say you cannot locate the file. '
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

/**
 * Strip bytes that exist only for the current turn before the message is
 * persisted.
 *
 * `base64DataUrl` is how the model sees the image *now*. It is several
 * megabytes of string, and the group snapshot is a JSON column — persisting it
 * would put the source image back in the database by a slower route than the
 * CDN upload this slice removed. The OCR text survives, so a later turn can
 * still discuss the image; it just cannot re-examine the pixels.
 */
export const withoutTransientBytes = (
  context: GroupChatAttachmentContext,
): GroupChatAttachmentContext => {
  if (!context.base64DataUrl) return context;
  const { base64DataUrl: _dropped, ...rest } = context;
  return rest;
};
