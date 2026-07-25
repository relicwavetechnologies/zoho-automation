import type { Logger } from '../../../shared/logger';
import type { RuntimeApprovalRepository } from '../../persistence/runtime-approval.repository';
import type { ApprovalResumerService } from '../../../application/approval/approval-resumer.service';
import type { LarkChannelAdapter } from './lark.adapter';
import { buildApprovalResolutionCard } from '../../../application/approval/approval-card-builder';
import { isGatewayApprovalMetadata } from '../../../application/approval/approval-origin';

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
 * Only processes events with kind='approval_decision' in the button value.
 *
 * Returns a Lark card update response, or null if not handled.
 */
export class LarkApprovalCardHandler {
  private readonly log: Logger;

  constructor(
    private readonly approvalRepo: RuntimeApprovalRepository,
    private readonly resumer:      ApprovalResumerService,
    private readonly larkAdapter:  LarkChannelAdapter,
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

    // Load approval and authorize actor
    const approvalResult = await this.approvalRepo.findById(approvalId);
    if (!approvalResult.ok || !approvalResult.value) {
      this.log.warn('approval_card.not_found', { approvalId });
      return { handled: true, responseBody: { toast: { type: 'error', content: 'Approval request not found.' } } };
    }

    const approval = approvalResult.value;
    // A card can be delivered even when persisting its Lark message ID fails.
    // That row deliberately remains `dispatching` as a duplicate-delivery
    // barrier, but the approval ID embedded in the delivered card is still
    // authoritative and atomicResolve accepts either live delivery state.
    if (!['dispatching', 'pending'].includes(approval.status)) {
      this.log.info('approval_card.already_resolved', { approvalId, status: approval.status });
      return {
        handled: true,
        responseBody: {
          toast: { type: 'info', content: `Already ${approval.status}.` },
        },
      };
    }

    if (approval.expiresAt && approval.expiresAt.getTime() <= Date.now()) {
      this.log.warn('approval_card.expired', { approvalId, expiresAt: approval.expiresAt.toISOString() });
      return {
        handled: true,
        responseBody: {
          toast: { type: 'error', content: 'This approval request has expired. Please ask the requester to try again.' },
        },
      };
    }

    const meta = approval.metadataJson;
    const resolvedManagerOpenId = isRecord(meta) ? meta['resolvedManagerOpenId'] : undefined;
    const resolvedManagerUserId = isRecord(meta) ? meta['resolvedManagerUserId'] : undefined;
    const requesterTenantKey = isRecord(meta) ? meta['tenantKey'] : undefined;

    if (
      typeof resolvedManagerOpenId !== 'string'
      || resolvedManagerOpenId.length === 0
      || typeof resolvedManagerUserId !== 'string'
      || resolvedManagerUserId.length === 0
      || typeof approval.companyId !== 'string'
      || approval.companyId.length === 0
    ) {
      this.log.error('approval_card.missing_manager_metadata', { approvalId });
      return {
        handled: true,
        responseBody: {
          toast: { type: 'error', content: 'Approval metadata is missing. Please ask the requester to try again.' },
        },
      };
    }

    const tenantMatches = typeof requesterTenantKey !== 'string'
      || requesterTenantKey.length === 0
      || requesterTenantKey === actor.tenantKey;
    if (
      actor.openId !== resolvedManagerOpenId
      || actor.userId !== resolvedManagerUserId
      || actor.companyId !== approval.companyId
      || !tenantMatches
    ) {
      this.log.warn('approval_card.unauthorized_actor', {
        approvalId,
        actorOpenId: actor.openId,
        actorUserId: actor.userId,
        actorCompanyId: actor.companyId,
        actorTenantKey: actor.tenantKey,
      });
      return {
        handled: true,
        responseBody: {
          toast: { type: 'error', content: 'You are not authorized to approve this request.' },
        },
      };
    }

    // Atomically resolve
    const resolveResult = await this.approvalRepo.atomicResolve(
      approvalId,
      decision as 'approved' | 'rejected',
      actor.openId,
    );

    if (!resolveResult.ok || !resolveResult.value) {
      this.log.warn('approval_card.resolve_failed', { approvalId });
      return {
        handled: true,
        responseBody: {
          toast: { type: 'error', content: 'Failed to record decision. Please try again.' },
        },
      };
    }

    const resolvedAt    = new Date();
    const resolvedByName = actor.displayName
      ?? event.operator?.name
      ?? event.user_name
      ?? actor.openId;

    // Update the approval card to show the decision (remove buttons)
    const updatedCard = buildApprovalResolutionCard(decision as 'approved' | 'rejected', resolvedByName, resolvedAt);
    if (approval.decisionMessageId) {
      await this.larkAdapter.updateMessageById(approval.decisionMessageId, updatedCard)
        .catch(e => this.log.warn('approval_card.update_failed', { error: String(e) }));
    }

    const isGatewayApproval = isGatewayApprovalMetadata(approval.metadataJson);
    if (!isGatewayApproval) {
      // Kick off engine resume asynchronously (must not block the HTTP response).
      void this.resumer.resume(approvalId, decision as 'approved' | 'rejected')
        .catch(e => this.log.error('approval_card.resume_failed', { approvalId, error: String(e) }));
    } else {
      this.log.info('approval_card.gateway_no_auto_resume', { approvalId, decision });
    }

    this.log.info('approval_card.handled', { approvalId, decision, isGatewayApproval });

    // Return a toast notification to the manager
    const toastContent = isGatewayApproval
      ? (decision === 'approved'
          ? 'Approved — the requester can now retry the exact desktop action.'
          : 'Rejected — the exact desktop action will remain blocked.')
      : (decision === 'approved'
          ? '✅ Approved — the action will now be executed.'
          : '❌ Rejected — the requester will be notified.');

    return {
      handled: true,
      responseBody: { toast: { type: 'success', content: toastContent } },
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
