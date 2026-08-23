import { createHash } from 'node:crypto';
import type { Logger } from '../../../shared/logger';
import type {
  ChannelDeliveryRepoPort,
  DeliveryRecord,
} from '../../persistence/channel-delivery.repository';
import type {
  RuntimeApprovalRepository,
  RuntimeApprovalRow,
} from '../../persistence/runtime-approval.repository';
import type { LarkChannelAdapter } from './lark.adapter';
import {
  classifyDeliveryFailure,
  deliveryBudgetExhausted,
  nextDeliveryDelayMs,
} from './lark-delivery-policy';
import { buildDecisionResolvedCard } from './lark-decision-card';
import { toProviderIdempotencyKey } from '../../../domain/channel/delivery-key';

export interface KnowledgeSkillOutcomeDeliveryPort {
  deliver(decisionId: string): Promise<void>;
  deliverPending(limit?: number): Promise<void>;
}

/**
 * Recoverable delivery for the two things a terminal Lark skill Decision owes:
 * replace its source card and tell the requester the exact applied revision.
 * RuntimeApproval is the durable source; ChannelDelivery owns retries and
 * provider idempotency, so a process restart cannot turn success into silence.
 */
export class LarkKnowledgeSkillOutcomeDelivery implements KnowledgeSkillOutcomeDeliveryPort {
  private readonly log: Logger;

  constructor(private readonly deps: {
    readonly approvals: Pick<
      RuntimeApprovalRepository,
      'findById' | 'listDeliverableLarkSkillOutcomeIds'
    >;
    readonly deliveries: ChannelDeliveryRepoPort;
    readonly lark: Pick<LarkChannelAdapter, 'sendDmToOpenId' | 'updateMessageById'>;
    readonly logger: Logger;
    readonly now?: () => Date;
    readonly random?: () => number;
  }) {
    this.log = deps.logger.child({ module: 'lark-knowledge-skill-outcome' });
  }

  async deliver(decisionId: string): Promise<void> {
    const loaded = await this.deps.approvals.findById(decisionId);
    if (!loaded.ok) throw loaded.error;
    if (!loaded.value || !isDeliverableSkillDecision(loaded.value)) return;
    await this.deliverRow(loaded.value);
  }

  async deliverPending(limit = 100): Promise<void> {
    const ids = await this.deps.approvals.listDeliverableLarkSkillOutcomeIds(limit);
    for (const id of ids) {
      try {
        await this.deliver(id);
      } catch (error) {
        this.log.error('knowledge_skill_outcome.recovery_failed', {
          decisionId: id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async deliverRow(row: RuntimeApprovalRow): Promise<void> {
    const metadata = asRecord(row.metadataJson);
    const openId = asString(metadata['requesterLarkOpenId']);
    if (!openId) {
      this.log.error('knowledge_skill_outcome.requester_missing', { decisionId: row.id });
      return;
    }
    const message = outcomeMessage(row);
    const byName = asString(metadata['requesterName'])
      ?? asString(metadata['requesterEmail'])
      ?? row.approvedBy
      ?? 'Requester';
    const verdict = row.status === 'consumed' ? 'approved' : 'rejected';
    const resultLabel = row.status === 'consumed' ? 'Applied'
      : row.status === 'rejected' ? 'Rejected'
        : 'Could not apply';

    if (row.decisionMessageId) {
      const card = buildDecisionResolvedCard({
        title: row.summary,
        verdict,
        summary: '',
        result: message,
        resultLabel,
        byName,
        at: row.updatedAt,
      });
      await this.deliverPart({
        row,
        suffix: 'card',
        payload: { kind: 'card_update', messageId: row.decisionMessageId, card },
        send: async () => {
          const updated = await this.deps.lark.updateMessageById(row.decisionMessageId!, card);
          return updated.ok
            ? { ok: true as const, providerMessageId: row.decisionMessageId! }
            : { ok: false as const, error: updated.error };
        },
      });
    }

    await this.deliverPart({
      row,
      suffix: 'message',
      payload: { kind: 'completion_dm', openId, content: message },
      send: async providerKey => {
        const sent = await this.deps.lark.sendDmToOpenId(openId, message, providerKey);
        return sent.ok
          ? { ok: true as const, providerMessageId: sent.value }
          : { ok: false as const, error: sent.error };
      },
    });
  }

  private async deliverPart(input: {
    readonly row: RuntimeApprovalRow;
    readonly suffix: 'card' | 'message';
    readonly payload: Record<string, unknown>;
    readonly send: (providerKey: string) => Promise<
      | { readonly ok: true; readonly providerMessageId: string }
      | { readonly ok: false; readonly error: unknown }
    >;
  }): Promise<void> {
    const idempotencyKey = `knowledge-skill-review:${input.row.id}:${input.suffix}`;
    const reserved = await this.deps.deliveries.reserve({
      channel: 'lark',
      idempotencyKey,
      runKey: input.row.runId,
      purpose: input.suffix === 'message' ? 'final' : 'status',
      ...(input.row.companyId ? { companyId: input.row.companyId } : {}),
      ...(asString(asRecord(input.row.metadataJson)['requesterLarkOpenId'])
        ? { chatId: asString(asRecord(input.row.metadataJson)['requesterLarkOpenId'])! }
        : {}),
      payload: input.payload,
    });
    if (!reserved.ok) throw reserved.error;
    if (reserved.value.outcome !== 'reserved') return;

    const providerKey = toProviderIdempotencyKey(
      idempotencyKey,
      value => createHash('sha256').update(value).digest('hex'),
    );
    const sent = await input.send(providerKey);
    if (sent.ok) {
      const marked = await this.deps.deliveries.markDelivered(
        reserved.value.record.deliveryId,
        sent.providerMessageId,
        reserved.value.record.claimAttempt,
      );
      if (!marked.ok) throw marked.error;
      return;
    }
    await this.recordFailure(reserved.value.record, sent.error);
  }

  private async recordFailure(record: DeliveryRecord, error: unknown): Promise<void> {
    const now = this.deps.now?.() ?? new Date();
    const verdict = classifyDeliveryFailure(asCause(error));
    const terminal = !verdict.retryable || deliveryBudgetExhausted(record.firstAttemptAt, now);
    const nextAttemptAt = terminal
      ? undefined
      : new Date(now.getTime() + nextDeliveryDelayMs(record.attempts, this.deps.random ?? Math.random));
    const marked = await this.deps.deliveries.markFailed(record.deliveryId, error, {
      claimAttempt: record.claimAttempt,
      terminal,
      ambiguous: verdict.ambiguous,
      ...(nextAttemptAt ? { nextAttemptAt } : {}),
    });
    if (!marked.ok) throw marked.error;
    this.log.warn('knowledge_skill_outcome.delivery_failed', {
      deliveryId: record.deliveryId,
      retryable: !terminal,
      reason: verdict.reason,
    });
  }
}

function isDeliverableSkillDecision(row: RuntimeApprovalRow): boolean {
  const metadata = asRecord(row.metadataJson);
  return row.kind === 'knowledge_skill_review'
    && ['consumed', 'rejected', 'failed'].includes(row.status)
    && metadata['sourceChannel'] === 'lark';
}

function outcomeMessage(row: RuntimeApprovalRow): string {
  const result = asRecord(row.executionResultJson);
  const exact = asString(result['message'])
    ?? asString(asRecord(result['result'])['message'])
    ?? asString(asRecord(result['data'])['message'])
    ?? asString(asRecord(asRecord(result['data'])['result'])['message']);
  if (exact) return exact;
  if (row.status === 'rejected') return 'The reviewed skill change was rejected. Nothing was changed.';
  if (row.status === 'failed') return 'The reviewed skill change could not be completed.';
  return 'The reviewed skill change was applied.';
}

function asCause(error: unknown): unknown {
  const payload = asRecord(asRecord(error)['payload']);
  return payload['cause'] ?? error;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
