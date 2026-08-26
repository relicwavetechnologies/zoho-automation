/**
 * A broadcast, as Divo reasons about one.
 *
 * Everything here is pure. The decisions that matter about a bulk send — is it
 * within the cap, who does it actually reach, what does this recipient's copy
 * say, is the batch finished — are arithmetic and string work, and none of them
 * needs a database or a gateway to answer. Keeping them here means they can be
 * tested against the awkward cases (a group of forty, a name with braces in it,
 * a gateway that reports more results than we sent) without standing anything up.
 */

/** Divo's word for where a broadcast has got to. */
export type BroadcastStatus =
  | 'queued'
  | 'sending'
  | 'completed'
  | 'cancelled'
  | 'failed';

/** Divo's word for what happened to one recipient. */
export type BroadcastRecipientStatus = 'pending' | 'sent' | 'failed' | 'cancelled';

/**
 * The most recipients one broadcast may carry.
 *
 * This is the gateway's own per-request ceiling, not a number picked here. One
 * broadcast is therefore exactly one gateway batch, which is what makes a single
 * idempotency key, a single cancel and a single honest progress figure possible.
 * Raising it means splitting across batches and stitching their progress back
 * together, and a progress bar assembled from several batches can report a
 * healthy total while one of its halves has quietly died.
 */
export const MAX_BROADCAST_RECIPIENTS = 100;

/** WhatsApp's own limit on a text message. The gateway rejects longer. */
export const MAX_BROADCAST_BODY = 4096;

export interface BroadcastRecipientInput {
  /** `919845010001@c.us` for a person, `1203630@g.us` for a group. */
  readonly waChatId: string;
  readonly displayName: string;
  readonly isGroup: boolean;
  /**
   * True when this number has never exchanged a message with the sending
   * handset. First contact is the thing WhatsApp's abuse systems act on, and
   * the gateway keeps a separate, much smaller daily allowance for it.
   */
  readonly cold: boolean;
}

/**
 * What a broadcast actually costs, socially.
 *
 * Computed rather than stored because every part of it changes as recipients are
 * picked, and a stale summary on a screen where somebody is deciding whether to
 * message sixty clients is worse than no summary.
 */
export interface BroadcastReach {
  readonly recipients: number;
  /**
   * How many of those are group chats.
   *
   * There is deliberately no "people reached" total beside this. Group sizes are
   * not something Divo knows: the gateway's group *list* carries only an id and
   * a subject, and the participant count needs a separate call per group. A
   * plausible-looking total assembled from guesses is worse than no total on a
   * screen where somebody is deciding whether to message a room they cannot see
   * the inside of — so the number is left out and the fact is stated instead.
   */
  readonly groups: number;
  readonly cold: number;
}

export function summarizeReach(
  recipients: readonly BroadcastRecipientInput[],
): BroadcastReach {
  return {
    recipients: recipients.length,
    groups: recipients.filter(r => r.isGroup).length,
    cold: recipients.filter(r => r.cold).length,
  };
}

/**
 * Why a broadcast may not be sent, or `null` when it may.
 *
 * One function rather than checks scattered through the route, because the same
 * question is asked twice — once by the screen to decide whether to enable the
 * button, and once by the route, which must not trust the screen. Two copies of
 * this rule is the duplicate-authority problem, and the copy that drifts is
 * always the one guarding the send.
 */
export type BroadcastRefusal =
  | { readonly reason: 'no_recipients' }
  | { readonly reason: 'too_many'; readonly count: number; readonly max: number }
  | { readonly reason: 'empty_body' }
  | { readonly reason: 'body_too_long'; readonly length: number; readonly max: number }
  | { readonly reason: 'duplicate_recipient'; readonly waChatId: string };

export function refuseBroadcast(input: {
  readonly recipients: readonly BroadcastRecipientInput[];
  readonly body: string;
}): BroadcastRefusal | null {
  const body = input.body.trim();
  if (input.recipients.length === 0) return { reason: 'no_recipients' };
  if (input.recipients.length > MAX_BROADCAST_RECIPIENTS) {
    return { reason: 'too_many', count: input.recipients.length, max: MAX_BROADCAST_RECIPIENTS };
  }
  if (!body) return { reason: 'empty_body' };
  if (body.length > MAX_BROADCAST_BODY) {
    return { reason: 'body_too_long', length: body.length, max: MAX_BROADCAST_BODY };
  }

  // The gateway collapses exact duplicates silently, so a list with the same
  // chat twice would send once and report a total one higher than it delivered.
  // Refused here instead, where the count can still be explained.
  const seen = new Set<string>();
  for (const recipient of input.recipients) {
    if (seen.has(recipient.waChatId)) {
      return { reason: 'duplicate_recipient', waChatId: recipient.waChatId };
    }
    seen.add(recipient.waChatId);
  }
  return null;
}

/** The refusal in words a person can act on. */
export function describeRefusal(refusal: BroadcastRefusal): string {
  switch (refusal.reason) {
    case 'no_recipients':
      return 'Pick at least one recipient.';
    case 'too_many':
      return `${refusal.count} recipients is over the limit of ${refusal.max}. `
        + 'One broadcast is one batch at the gateway, and the gateway takes no more than this.';
    case 'empty_body':
      return 'Write the message first.';
    case 'body_too_long':
      return `The message is ${refusal.length} characters; WhatsApp takes ${refusal.max}.`;
    case 'duplicate_recipient':
      return `${refusal.waChatId} appears twice in the recipient list.`;
  }
}

/**
 * Substitute the placeholders one recipient's copy needs.
 *
 * Only `{{name}}` is supported, and deliberately: every additional variable is
 * another thing that can render as an empty string in front of a client, and the
 * one people actually want is the name. A group gets the group's name, which is
 * how a person addressing that room would write it anyway.
 *
 * Substitution is single-pass over the template. A name that itself contains
 * `{{name}}` — a contact somebody saved as a joke, or a spoofed group subject —
 * must not be expanded again, so the replacement value is never rescanned.
 */
export function renderBody(template: string, recipient: { readonly displayName: string }): string {
  const name = firstName(recipient.displayName);
  return template.replace(/\{\{\s*name\s*\}\}/g, () => name);
}

/**
 * The part of a display name worth addressing somebody by.
 *
 * "Ritu Malhotra" is Ritu. "Sharma Sangeet — Core" is Sharma Sangeet, because a
 * group's name is a phrase and cutting it at the first space produces nonsense.
 * A name that reduces to nothing falls back to a greeting that reads as
 * deliberate rather than as a broken variable.
 */
export function firstName(displayName: string): string {
  const trimmed = displayName.trim();
  if (!trimmed) return 'there';
  // Groups are named with a qualifier after a dash; people are not.
  const beforeDash = trimmed.split(/\s+[—–-]\s+/)[0]!.trim();
  if (beforeDash !== trimmed) return beforeDash || 'there';
  return trimmed.split(/\s+/)[0] || 'there';
}

/**
 * The gateway's batch vocabulary, mapped to Divo's.
 *
 * Same shape and same reasoning as `normalizeGatewaySessionStatus`: an exact
 * table for the documented words, and anything unrecognised treated as the
 * pessimistic answer. The pessimistic answer here is `failed` rather than
 * `sending`, because a broadcast that is actually over but reads as running
 * keeps the poller alive forever and leaves a Cancel button on screen that can
 * no longer stop anything.
 */
const GATEWAY_BATCH_STATUS: Readonly<Record<string, BroadcastStatus>> = {
  pending: 'queued',
  processing: 'sending',
  completed: 'completed',
  cancelled: 'cancelled',
  failed: 'failed',
};

export function normalizeBatchStatus(remote: string | undefined | null): BroadcastStatus {
  const raw = (remote ?? '').trim().toLowerCase();
  return GATEWAY_BATCH_STATUS[raw] ?? 'failed';
}

const GATEWAY_RESULT_STATUS: Readonly<Record<string, BroadcastRecipientStatus>> = {
  pending: 'pending',
  sent: 'sent',
  failed: 'failed',
  cancelled: 'cancelled',
};

export function normalizeResultStatus(
  remote: string | undefined | null,
): BroadcastRecipientStatus {
  const raw = (remote ?? '').trim().toLowerCase();
  // Unknown means we do not know it landed, and a recipient wrongly shown as
  // delivered is the error somebody acts on. `pending` keeps the poller
  // interested; `sent` would retire the question permanently.
  return GATEWAY_RESULT_STATUS[raw] ?? 'pending';
}

/** Whether a broadcast is over, and the poller can stop asking. */
export function isTerminal(status: BroadcastStatus): boolean {
  return status === 'completed' || status === 'cancelled' || status === 'failed';
}

/**
 * How long a paced send will take, in seconds.
 *
 * The gateway waits `delayBetweenMessages` between sends and adds up to two
 * seconds of jitter, so the honest figure is a range. This returns the upper
 * end: a send that finishes early surprises nobody, and one that overruns the
 * estimate makes a person think it has hung.
 */
export function estimateSeconds(recipients: number, delayMs: number, jitter = true): number {
  if (recipients <= 1) return 0;
  const per = delayMs + (jitter ? 2000 : 0);
  return Math.round(((recipients - 1) * per) / 1000);
}
