/**
 * A button press on a decision card.
 *
 * Deliberately thin. The manager-approval handler beside it is three hundred
 * lines because it owns the whole settlement — load, authorize, expiry, resolve,
 * resume — and every other card flow grew its own copy of the same shape. Here
 * that all lives in `DecisionService`, and this file does the one thing that is
 * genuinely Lark's: translate the authenticated press. The webhook ACKs first
 * and runs this handler after the callback response has already gone out.
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

export interface LarkDecisionCardResult {
  readonly responseBody: unknown;
  /** Only a partial multi-question answer needs the callback worker to redraw. */
  readonly replaceSourceCard: boolean;
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
  ): Promise<LarkDecisionCardResult> {
    const action = actionValue(cardEvent);
    if (!isDecisionCardAction(action)) {
      return { responseBody: { ok: true }, replaceSourceCard: false };
    }

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
        replaceSourceCard: true,
        responseBody: {
          toast: { type: 'success', content: 'Got it.' },
          ...(card ? { card: { type: 'raw', data: card } } : {}),
        },
      };
    }

    if (!outcome.settled) {
      return {
        responseBody: { toast: { type: 'error', content: outcome.message } },
        replaceSourceCard: false,
      };
    }
    if (!outcome.ok) {
      this.log.info('decision_card.refused', { decisionId: action.decisionId, reason: outcome.reason });
      return {
        responseBody: { toast: { type: 'error', content: outcome.message } },
        replaceSourceCard: false,
      };
    }

    const waiting = outcome.followUp === 'waiting';
    const resultMessage = waiting && outcome.decision.evidence?.kind === 'skill'
      ? executionMessage(outcome.execution)
      : undefined;
    const resolved = waiting
      ? buildDecisionResolvedCardData({
          title: outcome.decision.title,
          verdict: outcome.verdict,
          summary: outcome.summary,
          ...(resultMessage ? { result: resultMessage, resultLabel: 'Waiting for approval' } : {}),
          byName: actor.displayName ?? actor.openId,
          at: new Date(),
        })
      : undefined;
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
      replaceSourceCard: waiting,
      responseBody: {
        toast: {
          type: 'success',
          content: toastContent,
        },
        ...(resolved ? { card: { type: 'raw', data: resolved } } : {}),
      },
    };
  }
}

function executionMessage(execution: unknown): string | undefined {
  const record = asRecord(execution);
  const direct = asString(record['message']);
  if (direct) return direct;
  const data = asRecord(record['data']);
  return asString(data['message']) ?? asString(asRecord(data['result'])['message']);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
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
