/**
 * The parts of attachment handling that are genuinely about Lark.
 *
 * What a container can open is not one of them — that moved to
 * `application/runtime/container-media`, because the same container answers the
 * browser, and a classifier living in this folder is how the web surface came to
 * accept a file a Lark DM would have refused. Re-exported here so the Lark call
 * sites read in one vocabulary.
 *
 * What is left is shaped by Lark's own message model: a quote-reply, an image
 * carried inline in a prompt, and a DM whose file arrives before its question.
 */

/**
 * Pixels are carried for the current turn only, never persisted, so the byte
 * cap bounds one prompt rather than a database row. Most Lark screenshots land
 * well under this.
 */
export const MAX_INLINE_IMAGE_BYTES = 4 * 1_024 * 1_024;

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
 *
 * There is no web equivalent and there should not be one: a browser composer
 * holds the file next to the field until the person presses send, so the file
 * and its question arrive together by construction. This exists because Lark
 * has no composer to hold anything.
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
