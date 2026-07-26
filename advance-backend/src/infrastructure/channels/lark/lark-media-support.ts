/**
 * What Divo can actually do with a Lark attachment today.
 *
 * Images work: they are downloaded for the turn, OCR'd, shown to the model, and
 * then forgotten. Documents do not work, and the honest thing is to say so
 * rather than to index a PDF nobody can retrieve or to answer from a filename.
 *
 * This is deliberately a code-level decision rather than a feature flag. A flag
 * implies there is a working path behind it; there is not. Document intake
 * needs the staging, retention, and ACL work in Wave 6 before it can be turned
 * on, so enabling it is a code change that arrives with that work.
 */

import type { GroupChatAttachmentContext } from '../../../domain/conversation/group-context';

export type LarkMediaSupport = 'supported' | 'unsupported_document';

/**
 * Only images are supported. `file` covers every document type the parser
 * recognises — PDF, DOCX, XLSX, CSV, TXT — and all of them are refused.
 */
export const classifyLarkMedia = (attachment: { readonly type: 'file' | 'image' }): LarkMediaSupport =>
  attachment.type === 'image' ? 'supported' : 'unsupported_document';

export const isSupportedLarkMedia = (attachment: { readonly type: 'file' | 'image' }): boolean =>
  classifyLarkMedia(attachment) === 'supported';

/**
 * Pixels are carried for the current turn only, never persisted, so the byte
 * cap bounds one prompt rather than a database row. Most Lark screenshots land
 * well under this.
 */
export const MAX_INLINE_IMAGE_BYTES = 4 * 1_024 * 1_024;

/**
 * Prompt-only context for a document Divo will not read.
 *
 * Written as an instruction rather than a canned sentence so Divo answers in
 * its own voice and can fold the refusal into whatever else the message asked.
 * The explicit "do not guess" line matters: without it a model will happily
 * infer a quarterly report's contents from `Q3-report.pdf`.
 */
export const unsupportedDocumentNotice = (fileName: string): string =>
  `[Document: "${fileName}" — NOT READ. Divo cannot read documents sent through Lark yet.\n`
  + 'Tell the user in your own words that you cannot read PDFs or documents over Lark right now, '
  + 'that the team is actively building it, and that it is coming soon. '
  + 'Then offer what works today: send a screenshot of the part that matters (you can read images), '
  + 'paste the relevant text straight into the chat, or use the Divo desktop app, which reads documents locally. '
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
  // A document is refused now, never later: no follow-up question can make a
  // PDF readable, so waiting for one would leave the user with no answer at
  // all rather than with an honest refusal.
  && input.unsupportedAttachmentCount === 0
  && !(input.text ?? '').trim();

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
