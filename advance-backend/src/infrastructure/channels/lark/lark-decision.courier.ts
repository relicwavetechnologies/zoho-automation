/**
 * Getting a decision in front of somebody who lives in Lark.
 *
 * The whole adapter, and it is this small on purpose: what to ask is the
 * decision module's, how to draw it is the card builder's, and what is left —
 * an open id and a send — is the only part that is actually Lark's.
 *
 * A failed send is reported rather than thrown. The row is the request and the
 * card is a side effect of it: somebody Divo cannot reach still has the
 * question waiting in Divo, and losing it because a DM bounced would be the
 * worse outcome by far.
 */
import type { DecisionCourier } from '../../../application/decision/decision.service';
import type { Logger } from '../../../shared/logger';
import type { LarkChannelAdapter } from './lark.adapter';
import { buildDecisionCard } from './lark-decision-card';

export class LarkDecisionCourier implements DecisionCourier {
  private readonly log: Logger;

  constructor(
    private readonly adapter: Pick<LarkChannelAdapter, 'sendDirectCard'>,
    logger: Logger,
    /** Where a question a card cannot hold sends the reader instead. */
    private readonly webUrl?: string,
  ) {
    this.log = logger.child({ courier: 'lark-decision' });
  }

  async deliver(input: {
    readonly decisionId: string;
    readonly decision: Parameters<DecisionCourier['deliver']>[0]['decision'];
    readonly questions: Parameters<DecisionCourier['deliver']>[0]['questions'];
    readonly approverOpenId: string;
  }): Promise<{ readonly ok: boolean; readonly messageId?: string }> {
    const card = buildDecisionCard({
      decision: input.decision,
      questions: input.questions,
      ...(this.webUrl ? { webUrl: this.webUrl } : {}),
    });
    if (!card) return { ok: false };

    const sent = await this.adapter.sendDirectCard(input.approverOpenId, card);
    if (!sent.ok) {
      this.log.warn('decision.card_send_failed', {
        decisionId: input.decisionId,
        reason: sent.error.payload?.reason,
      });
      return { ok: false };
    }
    return { ok: true, messageId: sent.value.messageId };
  }
}
