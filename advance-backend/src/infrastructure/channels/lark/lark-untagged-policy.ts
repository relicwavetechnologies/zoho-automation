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
