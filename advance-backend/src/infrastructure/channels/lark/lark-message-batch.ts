import type { IncomingMessage } from '../../../domain/channel/incoming-message';
import {
  buildMessageBatch,
  type BatchableMessage,
  type BatchBounds,
  type MessageBatch,
} from '../../../domain/channel/message-batch';
import type {
  IngressReceiptRepoPort,
  PendingLaneReceipt,
} from '../../persistence/ingress-receipt.repository';
import type { LarkChannelAdapter } from './lark.adapter';
import { buildLarkIngressLaneKey } from './lark-routing';
import { parseLarkAttachments } from './lark-attachment.parser';
import type { Logger } from '../../../shared/logger';

/** How many pending siblings to consider. Bounded so one lane cannot scan a table. */
const BATCH_LOOKAHEAD = 10;

export const toBatchableMessage = (
  incoming: IncomingMessage,
  rawEvent: Record<string, unknown>,
  acceptedAtMs: number,
): BatchableMessage => ({
  messageId: String(incoming.messageId),
  laneKey: buildLarkIngressLaneKey(incoming),
  requesterExternalId: incoming.userExternalId,
  chatId: String(incoming.chatId),
  threadId: incoming.threadId,
  rootMessageId: incoming.rootMessageId ? String(incoming.rootMessageId) : undefined,
  parentMessageId: incoming.parentMessageId ? String(incoming.parentMessageId) : undefined,
  text: incoming.text ?? '',
  hasAttachments: parseLarkAttachments(rawEvent).length > 0,
  isCommand: (incoming.text ?? '').trim().startsWith('/'),
  acceptedAtMs,
});

export interface AbsorbedBatch {
  readonly batch: MessageBatch;
  /** Receipts this run took ownership of and has already marked completed. */
  readonly absorbedReceiptIds: readonly string[];
}

/**
 * Fold the rest of a burst into this run.
 *
 * Ordering is the whole game here. Each sibling is *claimed before* it is
 * merged, so a message can only be absorbed by the run that successfully took
 * responsibility for it — a claim that comes back `leased` or `terminal` means
 * something else owns that message, and merging it anyway would answer it
 * twice. Only after the run has finished are the absorbed receipts completed;
 * completing them up front would lose the message entirely if this run then
 * failed.
 *
 * No debounce is added. Siblings are whatever already arrived while the
 * previous turn held the lane, which is where bursts actually pile up. Waiting
 * for more would delay every single-message reply to speed up a minority.
 */
export const absorbLaneBurst = async (input: {
  anchor: BatchableMessage;
  anchorReceiptId: string;
  repo: IngressReceiptRepoPort;
  adapter: Pick<LarkChannelAdapter, 'parseIncoming'>;
  log: Logger;
  bounds?: BatchBounds;
}): Promise<AbsorbedBatch> => {
  const { anchor, repo, adapter, log } = input;

  const pending = await repo.listBatchable(anchor.laneKey, {
    channel: 'lark',
    excludeReceiptId: input.anchorReceiptId,
    limit: BATCH_LOOKAHEAD,
  });

  if (!pending.ok) {
    // Batching is an optimisation. Losing it costs one extra turn; refusing to
    // run because the lookup failed costs the answer.
    log.warn('webhook.batch.lookup_failed', { error: pending.error.message });
    return { batch: buildMessageBatch(anchor, [], input.bounds), absorbedReceiptIds: [] };
  }

  const candidates: Array<{ message: BatchableMessage; receiptId: string }> = [];
  for (const row of pending.value) {
    const parsed = adapter.parseIncoming(row.payload);
    if (!parsed.ok) continue;
    candidates.push({
      message: toBatchableMessage(parsed.value, row.payload, row.acceptedAt.getTime()),
      receiptId: row.receiptId,
    });
  }

  const proposed = buildMessageBatch(
    anchor,
    candidates.map(c => c.message),
    input.bounds,
  );
  if (proposed.merged.length === 0) {
    return { batch: proposed, absorbedReceiptIds: [] };
  }

  const receiptFor = new Map(candidates.map(c => [c.message.messageId, c.receiptId]));
  const claimed: BatchableMessage[] = [];
  const absorbedReceiptIds: string[] = [];

  for (const message of proposed.merged) {
    const receiptId = receiptFor.get(message.messageId);
    if (!receiptId) continue;
    const claim = await repo.claim(receiptId);
    if (!claim.ok) {
      log.warn('webhook.batch.claim_failed', { receiptId, error: claim.error.message });
      break;
    }
    if (claim.value.outcome !== 'claimed') {
      // Someone else owns this message. Stop rather than skip: the batch has to
      // stay a contiguous run of what the person said.
      log.info('webhook.batch.candidate_taken', { receiptId, outcome: claim.value.outcome });
      break;
    }
    claimed.push(message);
    absorbedReceiptIds.push(receiptId);
  }

  const batch = buildMessageBatch(anchor, claimed, input.bounds);
  if (batch.merged.length > 0) {
    log.info('webhook.batch.merged', {
      anchorMessageId: anchor.messageId,
      mergedCount: batch.merged.length,
      sourceMessageIds: batch.sourceMessageIds,
    });
  }
  return { batch, absorbedReceiptIds };
};

/**
 * Mark absorbed receipts finished once the run that answered them succeeded.
 *
 * Failures are logged and swallowed: the run already produced its reply, and
 * throwing here would fail a job whose real work is done, which retries the
 * whole turn and asks the model the same question again.
 */
export const completeAbsorbedReceipts = async (
  receiptIds: readonly string[],
  repo: IngressReceiptRepoPort,
  log: Logger,
): Promise<void> => {
  for (const receiptId of receiptIds) {
    const completed = await repo.markCompleted(receiptId);
    if (!completed.ok) {
      log.error('webhook.batch.complete_failed', {
        receiptId, error: completed.error.message,
      });
    }
  }
};

export type { PendingLaneReceipt };
