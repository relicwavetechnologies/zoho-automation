/**
 * Merging a burst of messages into one turn.
 *
 * Someone typing three quick lines means one request, not three. Answering each
 * separately is slower, costs three model runs, and produces three replies to
 * what the person experienced as a single thought.
 *
 * The whole risk of this feature is merging things that were *not* one thought.
 * That is why compatibility is spelled out as an allow-list of sameness rather
 * than a list of things that block merging: a field nobody thought about fails
 * closed, into its own turn, which is merely the old behaviour.
 */

export interface BatchableMessage {
  readonly messageId: string;
  readonly laneKey: string;
  /** Lark open ID of the sender. Authority is per-sender; never merge across. */
  readonly requesterExternalId: string;
  readonly chatId: string;
  readonly threadId?: string | undefined;
  readonly rootMessageId?: string | undefined;
  /** The message this one quotes, if any. A different quote is a different question. */
  readonly parentMessageId?: string | undefined;
  readonly text: string;
  readonly hasAttachments: boolean;
  /** Whether this message may start an agent run. Never merge across this boundary. */
  readonly invokesAgent: boolean;
  /** `/new`, `/login` and friends act immediately and are never merged. */
  readonly isCommand: boolean;
  readonly acceptedAtMs: number;
}

export interface BatchBounds {
  /** How far apart two messages may be and still count as one thought. */
  readonly windowMs: number;
  readonly maxMessages: number;
  readonly maxChars: number;
}

export const DEFAULT_BATCH_BOUNDS: BatchBounds = {
  windowMs: 45_000,
  maxMessages: 5,
  maxChars: 4_000,
};

const same = (a: string | undefined, b: string | undefined): boolean =>
  (a ?? '') === (b ?? '');

/**
 * Whether `candidate` belongs to the same turn as `anchor`.
 *
 * Deliberately strict. Every clause here is a case where merging would change
 * the answer rather than merely the packaging:
 *
 * - a different requester would run one person's words under another's
 *   authority, which is the exact failure Wave 4B exists to prevent;
 * - a different thread, root, or quoted parent is a different conversation,
 *   and Wave 4A separated those on purpose;
 * - an attachment carries its own handling and its own refusal, so folding it
 *   into a neighbouring message would hide that;
 * - tagged and ambient messages have different invocation semantics;
 * - a command is answered directly, not by the agent, so it has no turn to
 *   merge into.
 */
export const isBatchCompatible = (
  anchor: BatchableMessage,
  candidate: BatchableMessage,
): boolean => {
  if (candidate.messageId === anchor.messageId) return false;
  if (candidate.laneKey !== anchor.laneKey) return false;
  if (candidate.requesterExternalId !== anchor.requesterExternalId) return false;
  if (candidate.chatId !== anchor.chatId) return false;
  if (!same(candidate.threadId, anchor.threadId)) return false;
  if (!same(candidate.rootMessageId, anchor.rootMessageId)) return false;
  if (!same(candidate.parentMessageId, anchor.parentMessageId)) return false;
  if (candidate.hasAttachments || anchor.hasAttachments) return false;
  if (candidate.invokesAgent !== anchor.invokesAgent) return false;
  if (candidate.isCommand || anchor.isCommand) return false;
  if (!candidate.text.trim()) return false;
  return true;
};

export interface MessageBatch {
  /** The message whose turn this is. Its identity owns the reply and the run. */
  readonly anchor: BatchableMessage;
  /** Absorbed messages, oldest first. Empty when nothing was merged. */
  readonly merged: readonly BatchableMessage[];
  /** Every source message ID, anchor first — the run audit's record of what it answered. */
  readonly sourceMessageIds: readonly string[];
  readonly text: string;
}

/**
 * Build the batch for `anchor` from the messages already waiting in its lane.
 *
 * Candidates are taken in arrival order and stop at the first bound that trips,
 * rather than skipping ahead to find something that fits: a batch must be a
 * contiguous run of what the person actually said, or the reply answers their
 * words in an order they never used.
 */
export const buildMessageBatch = (
  anchor: BatchableMessage,
  candidates: readonly BatchableMessage[],
  bounds: BatchBounds = DEFAULT_BATCH_BOUNDS,
): MessageBatch => {
  const merged: BatchableMessage[] = [];
  let chars = anchor.text.length;

  const ordered = [...candidates].sort((a, b) => a.acceptedAtMs - b.acceptedAtMs);

  for (const candidate of ordered) {
    if (merged.length + 1 >= bounds.maxMessages) break;
    if (!isBatchCompatible(anchor, candidate)) break;
    if (Math.abs(candidate.acceptedAtMs - anchor.acceptedAtMs) > bounds.windowMs) break;
    const nextChars = chars + candidate.text.length + 1;
    if (nextChars > bounds.maxChars) break;
    merged.push(candidate);
    chars = nextChars;
  }

  const parts = [anchor, ...merged]
    .sort((a, b) => a.acceptedAtMs - b.acceptedAtMs)
    .map(message => message.text.trim())
    .filter(Boolean);

  return {
    anchor,
    merged,
    sourceMessageIds: [anchor.messageId, ...merged.map(m => m.messageId)],
    text: parts.join('\n'),
  };
};
