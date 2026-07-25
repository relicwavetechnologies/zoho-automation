/**
 * Policy for group messages that do not mention Divo.
 *
 * An untagged group message is ambient conversation between colleagues. Divo is
 * present in the room but was not addressed, so what it may keep from that
 * message is a policy decision rather than a product default.
 *
 * The two questions are deliberately separate because they carry different
 * costs. Retaining text keeps a bounded, compacted room transcript so a later
 * "@Divo, what did we decide above?" can be answered — the content is already
 * visible to everyone in the room. Processing attachments is not equivalent: it
 * downloads the file out of Lark, OCRs it, uploads it to a third-party CDN, and
 * indexes it as shared company knowledge. That moves data no one asked Divo to
 * touch into systems the room's members never see.
 *
 * Defaults follow that asymmetry: retain text, ignore attachments.
 *
 * The two settings are independent, and `off` + `process` is a coherent but
 * wasteful combination: the attachment is downloaded, OCR'd, uploaded, and
 * indexed, while the transcript entry that would have carried its context is
 * discarded. The ingestion worker then logs a missing-message warning per file.
 * Left as configured rather than silently corrected, because a deployment that
 * asks for exactly this is asking for indexed files without a room transcript.
 */

export interface UntaggedGroupPolicy {
  /** Keep untagged group text in the bounded room transcript. */
  readonly retainText: boolean;
  /** Download, OCR, upload, and index files on untagged group messages. */
  readonly processAttachments: boolean;
}

type UntaggedPolicyEnv = {
  readonly LARK_UNTAGGED_GROUP_TEXT_RETENTION: 'retain' | 'off';
  readonly LARK_UNTAGGED_GROUP_ATTACHMENTS: 'ignore' | 'process';
};

export const resolveUntaggedGroupPolicy = (env: UntaggedPolicyEnv): UntaggedGroupPolicy => ({
  retainText: env.LARK_UNTAGGED_GROUP_TEXT_RETENTION === 'retain',
  processAttachments: env.LARK_UNTAGGED_GROUP_ATTACHMENTS === 'process',
});

/**
 * True when this message reaches the room without addressing Divo.
 *
 * Deliberately narrower than "Divo will not reply": a DM is never untagged
 * ambient context, because sending Divo a direct message is itself the address.
 */
export const isUntaggedGroupMessage = (
  incoming: { chatType?: string; mentionsSelf?: boolean },
): boolean => incoming.chatType === 'group' && !incoming.mentionsSelf;

/**
 * Whether this message's attachments may be downloaded, OCR'd, and indexed.
 *
 * Separate from the work itself so the decision is testable without reaching
 * Lark. The gate must be evaluated *before* preparation, not used to discard
 * its output: by the time an attachment context exists, the file has already
 * left Lark and been written to a CDN and an index.
 */
export const mayPrepareAttachments = (input: {
  readonly attachmentCount: number;
  readonly untagged: boolean;
  readonly policy: UntaggedGroupPolicy;
}): boolean =>
  input.attachmentCount > 0
  && (!input.untagged || input.policy.processAttachments);
