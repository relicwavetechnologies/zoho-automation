/**
 * A button press on a decision card.
 *
 * Deliberately thin. The manager-approval handler beside it is three hundred
 * lines because it owns the whole settlement — load, authorize, expiry, resolve,
 * resume — and every other card flow grew its own copy of the same shape. Here
 * that all lives in `DecisionService`, and this file does the two things that
 * are genuinely Lark's: read the press, and answer within the three seconds
 * Feishu allows before it gives up on the callback.
 */
import type { Logger } from '../../../shared/logger';
import type { DecisionService } from '../../../application/decision/decision.service';
import {
  buildDecisionCardData,
  buildDecisionResolvedCardData,
  isDecisionCardAction,
} from './lark-decision-card';

export interface LarkDecisionCardActor {
  readonly tenantKey: string;
  readonly openId: string;
  readonly userId: string;
  readonly companyId: string;
  readonly displayName?: string;
}

export class LarkDecisionCardHandler {
  private readonly log: Logger;

  constructor(
    private readonly decisions: DecisionService,
    logger: Logger,
    /** Where somebody is sent when a card cannot hold the question. */
    private readonly webUrl?: string,
  ) {
    this.log = logger.child({ handler: 'lark-decision-card' });
  }

  /** Is this press ours? Asked before the generic approval handler sees it. */
  claims(cardEvent: unknown): boolean {
    return isDecisionCardAction(actionValue(cardEvent));
  }

  async handle(
    cardEvent: unknown,
    actor: LarkDecisionCardActor,
  ): Promise<{ readonly responseBody: unknown }> {
    const action = actionValue(cardEvent);
    if (!isDecisionCardAction(action)) return { responseBody: { ok: true } };

    const outcome = await this.decisions.answerOne(
      {
        userId: actor.userId,
        companyId: actor.companyId,
        ...(actor.displayName ? { displayName: actor.displayName } : {}),
        lark: { openId: actor.openId, tenantKey: actor.tenantKey },
      },
      action.decisionId,
      action.questionId,
      action.value,
    );

    if (!outcome.settled && outcome.ok) {
      /* More to ask. The same card becomes the next question rather than a
         second card arriving underneath it — a three-part decision should read
         as one thing being worked through, not as three requests. */
      const card = buildDecisionCardData({
        decision: outcome.decision,
        questions: outcome.decision.questions,
        answer: outcome.answer,
        ...(this.webUrl ? { webUrl: this.webUrl } : {}),
      });
      this.log.info('decision_card.advanced', { decisionId: action.decisionId, questionId: action.questionId });
      return {
        responseBody: {
          toast: { type: 'success', content: 'Got it.' },
          ...(card ? { card: { type: 'raw', data: card } } : {}),
        },
      };
    }

    if (!outcome.settled) {
      return { responseBody: { toast: { type: 'error', content: outcome.message } } };
    }
    if (!outcome.ok) {
      this.log.info('decision_card.refused', { decisionId: action.decisionId, reason: outcome.reason });
      return { responseBody: { toast: { type: 'error', content: outcome.message } } };
    }

    const resolved = buildDecisionResolvedCardData({
      title: outcome.decision.title,
      verdict: outcome.verdict,
      summary: outcome.summary,
      byName: actor.displayName ?? actor.openId,
      at: new Date(),
    });
    const toastContent = outcome.followUp === 'waiting'
      ? 'Reviewed. The exact skill change is waiting for its authority decision.'
      : outcome.followUp === 'retry'
      ? (outcome.verdict === 'approved'
          ? 'Approved — the requester can now retry the exact action.'
          : 'Rejected — the exact action will remain blocked.')
      : (outcome.verdict === 'approved'
          ? 'Done — Divo is carrying on.'
          : 'Stopped. Nothing was changed.');
    this.log.info('decision_card.settled', { decisionId: action.decisionId, verdict: outcome.verdict });
    return {
      responseBody: {
        toast: {
          type: 'success',
          content: toastContent,
        },
        card: { type: 'raw', data: resolved },
      },
    };
  }
}

/**
 * The press's payload, however Lark encoded it.
 *
 * Lark sends the value as an object, a JSON string, or a double-encoded JSON
 * string depending on the card version and how it was sent — the same three
 * cases the approval handler unwraps, for the same reason.
 */
function actionValue(cardEvent: unknown): unknown {
  const event = typeof cardEvent === 'object' && cardEvent !== null
    ? cardEvent as Record<string, unknown>
    : {};
  const action = typeof event['action'] === 'object' && event['action'] !== null
    ? event['action'] as Record<string, unknown>
    : {};
  let candidate: unknown = action['value'];
  for (let depth = 0; depth < 2 && typeof candidate === 'string'; depth += 1) {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return undefined;
    }
  }
  return candidate;
}
