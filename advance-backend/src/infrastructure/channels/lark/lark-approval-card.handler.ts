import type { Logger } from '../../../shared/logger';
import type { DecisionService } from '../../../application/decision/decision.service';
import { confirmAnswer } from '../../../domain/decision/decision';
import { buildApprovalResolutionCardData } from '../../../application/approval/approval-card-builder';

interface CardActionPayload {
  kind:       string;
  approvalId: string;
  decision:   string;
}

export interface LarkAuthenticatedCardActor {
  tenantKey:  string;
  openId:     string;
  userId:     string;
  companyId:  string;
  aiRole:     string;
  displayName?: string;
}

// Supports both Card 2.0 (operator wrapper) and Card 1.0 (open_id at top level).
interface CardActionTriggerEvent {
  action: {
    value: string | Record<string, unknown>;
    tag:   string;
  };
  // Card 2.0
  operator?: {
    open_id?:  string;
    user_id?:  string;
    name?:     string;
  };
  // Card 1.0
  open_id?:    string;
  user_id?:    string;
  user_name?:  string;
  open_message_id?: string;
}

/**
 * Handles `card.action.trigger` webhook events from Lark.
 * Only processes old events with kind='approval_decision' in the button value.
 *
 * This is a compatibility adapter for cards already delivered before manager
 * approvals move to `decision_answer`. It parses the old value, lets
 * `DecisionService` authorize and settle the row, and keeps the old callback
 * card and toast shape for the client that is still holding that card.
 */
export class LarkApprovalCardHandler {
  private readonly log: Logger;

  constructor(
    private readonly decisions: DecisionService,
    logger: Logger,
  ) {
    this.log = logger.child({ handler: 'lark-approval-card' });
  }

  /**
   * Entry point. Returns an HTTP response body for Lark (must be returned within 3s).
   * The engine resume is kicked off asynchronously after the response is sent.
   */
  async handle(
    rawEvent: unknown,
    actor: LarkAuthenticatedCardActor,
  ): Promise<{ handled: boolean; responseBody?: unknown }> {
    const event = rawEvent as CardActionTriggerEvent | null;
    this.log.info('approval_card.handle.entry', {
      hasEvent:   !!event,
      hasAction:  !!event?.action,
      eventKeys:  event ? Object.keys(event) : [],
    });
    if (!event?.action) return { handled: false };

    // Parse the action value. Lark may pass it as:
    //   • a plain object (preferred — what we now send)
    //   • a JSON string (single-encoded)
    //   • a double-encoded JSON string (when value was sent as stringified JSON
    //     and Lark re-stringified it on the way back)
    let payload: CardActionPayload | undefined;
    const rawValue = event.action.value;
    try {
      let candidate: unknown = rawValue;
      // Unwrap up to 2 levels of JSON encoding
      for (let i = 0; i < 2 && typeof candidate === 'string'; i++) {
        candidate = JSON.parse(candidate);
      }
      payload = candidate as CardActionPayload;
    } catch (e) {
      this.log.warn('approval_card.parse_failed', { rawValue, error: String(e) });
      return { handled: false };
    }

    this.log.info('approval_card.parsed', {
      rawValueType:    typeof rawValue,
      rawValueSample:  typeof rawValue === 'string' ? rawValue.slice(0, 500) : JSON.stringify(rawValue)?.slice(0, 500),
      payloadKeys:     payload && typeof payload === 'object' ? Object.keys(payload) : [],
      payloadKind:     payload?.kind,
      approvalId:      payload?.approvalId,
      decision:        payload?.decision,
    });

    if (!payload || payload.kind !== 'approval_decision') {
      this.log.info('approval_card.skipped_kind', { kind: payload?.kind });
      return { handled: false };
    }

    const { approvalId, decision } = payload;
    if (!approvalId || (decision !== 'approved' && decision !== 'rejected')) {
      this.log.warn('approval_card.invalid_payload', { approvalId, decision });
      return { handled: false };
    }

    const resolvedByName = actor.displayName
      ?? event.operator?.name
      ?? event.user_name
      ?? actor.openId;

    const outcome = await this.decisions.settle(
      {
        userId: actor.userId,
        companyId: actor.companyId,
        ...(actor.displayName ? { displayName: actor.displayName } : {}),
        lark: { openId: actor.openId, tenantKey: actor.tenantKey },
      },
      approvalId,
      confirmAnswer(decision as 'approved' | 'rejected'),
    );

    if (!outcome.ok) {
      this.log.info('approval_card.refused', { approvalId, reason: outcome.reason });
      return {
        handled: true,
        responseBody: { toast: failureToast(outcome) },
      };
    }

    const callbackCard = buildApprovalResolutionCardData(
      outcome.verdict,
      resolvedByName,
      new Date(),
    );
    const toastContent = outcome.followUp === 'retry'
      ? (outcome.verdict === 'approved'
          ? 'Approved — the requester can now retry the exact desktop action.'
          : 'Rejected — the exact desktop action will remain blocked.')
      : (outcome.verdict === 'approved'
          ? '✅ Approved — the action will now be executed.'
          : '❌ Rejected — the requester will be notified.');

    this.log.info('approval_card.handled', {
      approvalId,
      decision,
      followUp: outcome.followUp,
    });

    return {
      handled: true,
      responseBody: {
        toast: { type: 'success', content: toastContent },
        card: { type: 'raw', data: callbackCard },
      },
    };
  }
}

function failureToast(
  outcome: Extract<Awaited<ReturnType<DecisionService['settle']>>, { ok: false }>,
): { readonly type: 'error' | 'info'; readonly content: string } {
  if (outcome.reason === 'already_resolved') {
    return {
      type: 'info',
      content: outcome.message.replace(/^This request was already /, 'Already '),
    };
  }
  if (outcome.reason === 'not_found') {
    return { type: 'error', content: 'Approval request not found.' };
  }
  if (outcome.reason === 'expired') {
    return { type: 'error', content: 'This approval request has expired. Please ask the requester to try again.' };
  }
  if (outcome.reason === 'failed') {
    return { type: 'error', content: 'Failed to record decision. Please try again.' };
  }
  return { type: 'error', content: outcome.message };
}
