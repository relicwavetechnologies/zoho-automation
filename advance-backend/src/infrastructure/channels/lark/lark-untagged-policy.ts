/**
 * Policy for group messages that do not mention Divo.
 *
 * An untagged group message is ambient conversation between colleagues. Divo is
 * present in the room but was not addressed. Its text always enters the
 * bounded room transcript; only attachment processing is configurable.
 *
 * Processing attachments is not equivalent to retaining text: it downloads the
 * file out of Lark, OCRs it, uploads it to a third-party CDN, and indexes it as
 * shared company knowledge. That remains opt-in.
 */

export interface UntaggedGroupPolicy {
  /** Download, OCR, upload, and index files on untagged group messages. */
  readonly processAttachments: boolean;
}

export type UntaggedPolicyEnv = {
  readonly LARK_UNTAGGED_GROUP_ATTACHMENTS: 'ignore' | 'process';
};

export const resolveUntaggedGroupPolicy = (env: UntaggedPolicyEnv): UntaggedGroupPolicy => ({
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
 * Whether one attachment may be downloaded, extracted, and indexed.
 *
 * Documents are exempt from the untagged gate. Lark gives a file message no
 * text field, so a document upload can never carry an @mention — every one of
 * them arrives untagged, and gating on the mention would mean Divo could never
 * read a document posted in a group at all. The gate's own rationale also no
 * longer holds for them: a document is indexed against the chat it was posted
 * in, not as shared company knowledge.
 *
 * Images stay gated. Preparing one sends the pixels to a third-party vision
 * provider, and an image can be posted with a mention when it is meant for
 * Divo, so the consent signal is real rather than structurally impossible.
 */
export const mayPrepareAttachment = (input: {
  readonly kind: 'file' | 'image';
  readonly untagged: boolean;
  readonly policy: UntaggedGroupPolicy;
}): boolean =>
  input.kind === 'file'
  || !input.untagged
  || input.policy.processAttachments;

/**
 * Whether any of this message's attachments are worth preparing.
 *
 * A message-level short-circuit so an untagged image-only message costs no
 * work at all. The per-attachment gate above is what actually decides; this
 * must stay consistent with it or a document would be dropped before
 * `mayPrepareAttachment` ever sees it.
 *
 * The gate is evaluated *before* preparation, not used to discard its output:
 * by the time an attachment context exists, the file has already left Lark.
 */
export const mayPrepareAttachments = (input: {
  readonly attachmentCount: number;
  readonly documentCount?: number;
  readonly untagged: boolean;
  readonly policy: UntaggedGroupPolicy;
}): boolean =>
  input.attachmentCount > 0
  && (!input.untagged
    || input.policy.processAttachments
    || (input.documentCount ?? 0) > 0);

// ─── Per-company overrides ──────────────────────────────────────────────────

/** Admin control key a company may set to override the deployment default. */
export const UNTAGGED_ATTACHMENTS_CONTROL = 'lark.untagged.attachments';

export interface UntaggedPolicySource {
  readonly value: 'ignore' | 'process';
  readonly origin: 'company' | 'deployment';
}

export interface ResolvedUntaggedGroupPolicy extends UntaggedGroupPolicy {
  readonly attachments: UntaggedPolicySource;
}

type ControlRow = { readonly controlKey: string; readonly value: string };

/**
 * Layer a company's overrides over the deployment default.
 *
 * One deployment serves many companies, so a process-level switch cannot be the
 * final word: enabling attachment processing for the company that asked would
 * otherwise enable it for every other company sharing the process.
 *
 * An unrecognised stored value falls back to the deployment default rather than
 * to the permissive option — a typo in a control row must not silently start
 * indexing a company's files.
 */
export const resolveCompanyUntaggedGroupPolicy = (input: {
  readonly env: UntaggedPolicyEnv;
  readonly controls: readonly ControlRow[];
}): ResolvedUntaggedGroupPolicy => {
  const deployment = resolveUntaggedGroupPolicy(input.env);
  const stored = (key: string): string | undefined =>
    input.controls.find(row => row.controlKey === key)?.value;

  const attachmentOverride = stored(UNTAGGED_ATTACHMENTS_CONTROL);

  const attachments: UntaggedPolicySource =
    attachmentOverride === 'ignore' || attachmentOverride === 'process'
      ? { value: attachmentOverride, origin: 'company' }
      : { value: deployment.processAttachments ? 'process' : 'ignore', origin: 'deployment' };

  return {
    processAttachments: attachments.value === 'process',
    attachments,
  };
};

// ─── Send-only rooms ────────────────────────────────────────────────────────

/**
 * Whether this Lark room is a follow-up digest's delivery target.
 *
 * A room somebody pointed a digest at is a feed, not a chat: Divo posts a
 * schedule's output into it, and a colleague typing `@Divo` there is talking in
 * front of the team rather than asking Divo for something. Answering turns the
 * feed into a chat surface — and one that can fail out loud in front of
 * everyone when a model call drops, which is exactly how this was noticed.
 *
 * Fails to `false`. A lookup that cannot answer must not silence Divo in a room
 * where somebody is waiting for a reply: the mistake is recoverable that way
 * round (an unwanted answer) and confusing the other way (a bot that stopped
 * responding for no visible reason).
 */
export const isSendOnlyDigestRoom = async (input: {
  readonly prisma: {
    readonly followUpDigest: {
      findFirst(args: unknown): Promise<{ readonly sendOnly: boolean } | null>;
    };
  } | undefined;
  readonly companyId: string | undefined;
  readonly chatId: string | undefined;
  readonly log?: { warn(message: string, meta?: Record<string, unknown>): void };
}): Promise<boolean> => {
  if (!input.prisma || !input.companyId || !input.chatId) return false;
  try {
    const row = await input.prisma.followUpDigest.findFirst({
      where: { companyId: input.companyId, larkChatId: input.chatId },
      select: { sendOnly: true },
    });
    return row?.sendOnly === true;
  } catch (error) {
    input.log?.warn('lark.send_only_room.lookup_failed', { error: String(error) });
    return false;
  }
};
