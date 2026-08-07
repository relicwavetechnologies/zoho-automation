import type { Logger } from '../../shared/logger';
import type { AuditService } from '../observability/audit.service';
import type { RuntimeApprovalRepository, RuntimeApprovalRow } from '../../infrastructure/persistence/runtime-approval.repository';
import type { ApprovalResumerService } from './approval-resumer.service';
import { describeToolAction, type ToolActionDescription } from './describe-tool-action';
import { approvalResumesAutomatically, isGatewayApprovalMetadata } from './approval-origin';
import type { ApprovalCardInput } from './approval-card-builder';

/**
 * The approval inbox: the same decisions the Lark card carries, reachable by
 * anyone signed into Divo.
 *
 * A card in a chat app was the only way an approval could ever be seen or
 * answered, which quietly made a Lark account part of being a manager. The
 * RuntimeApproval row is the request; a card and this inbox are two views of
 * it, and either can resolve it — `atomicResolve` is what keeps them from
 * both resolving it twice.
 */

export interface ApprovalActor {
  readonly userId: string;
  readonly companyId: string;
  readonly displayName?: string;
}

export interface ApprovalInboxItem {
  readonly id: string;
  readonly toolId: string;
  readonly action: string;
  readonly status: string;
  readonly requestedAt: string;
  readonly expiresAt: string | null;
  readonly requestedByName: string;
  readonly approverName: string;
  readonly departmentName: string | null;
  readonly deliveredVia: string;
  readonly description: ToolActionDescription;
  /** The exact payload, for an approver who wants to see everything. */
  readonly payload: unknown;
}

export interface ApprovalInbox {
  readonly awaitingMe: readonly ApprovalInboxItem[];
  readonly requestedByMe: readonly ApprovalInboxItem[];
}

export type ApprovalDecisionOutcome =
  | { readonly ok: true; readonly decision: 'approved' | 'rejected'; readonly item: ApprovalInboxItem }
  | { readonly ok: false; readonly reason: 'not_found' | 'already_resolved' | 'expired' | 'forbidden' | 'failed'; readonly message: string };

export interface ApprovalInboxDeps {
  readonly approvals: RuntimeApprovalRepository;
  readonly resumer: ApprovalResumerService;
  readonly logger: Logger;
  readonly audit?: Pick<AuditService, 'record'>;
  /** Updates the delivered Lark card in place once a decision lands elsewhere. */
  readonly onResolvedCard?: (
    messageId: string,
    decision: 'approved' | 'rejected',
    byName: string,
    request: Omit<ApprovalCardInput, 'approvalId' | 'approverName'>,
  ) => Promise<void>;
}

export class ApprovalInboxService {
  constructor(private readonly deps: ApprovalInboxDeps) {}

  async list(actor: ApprovalActor): Promise<ApprovalInbox> {
    const result = await this.deps.approvals.listInboxFor({ companyId: actor.companyId, userId: actor.userId });
    if (!result.ok) {
      this.deps.logger.error('approval_inbox.list_failed', { error: result.error.message });
      return { awaitingMe: [], requestedByMe: [] };
    }
    return {
      awaitingMe: result.value.awaitingMe.map(present),
      requestedByMe: result.value.requestedByMe.map(present),
    };
  }

  async decide(
    actor: ApprovalActor,
    approvalId: string,
    decision: 'approved' | 'rejected',
  ): Promise<ApprovalDecisionOutcome> {
    const found = await this.deps.approvals.findById(approvalId);
    if (!found.ok || !found.value) {
      return { ok: false, reason: 'not_found', message: 'That approval request no longer exists.' };
    }
    const approval = found.value;

    // `dispatching` is live for the same reason the card handler accepts it: a
    // request can be delivered before its message id is persisted.
    if (!['dispatching', 'pending'].includes(approval.status)) {
      return { ok: false, reason: 'already_resolved', message: `This request was already ${approval.status}.` };
    }
    if (approval.expiresAt && approval.expiresAt.getTime() <= Date.now()) {
      return { ok: false, reason: 'expired', message: 'This request expired. Ask the requester to try again.' };
    }

    const meta = isRecord(approval.metadataJson) ? approval.metadataJson : {};
    const approverUserId = readString(meta['resolvedManagerUserId']);
    if (!approverUserId || approval.companyId !== actor.companyId || approverUserId !== actor.userId) {
      // Persisted, not just logged: someone answering a decision that was not
      // theirs to make is a security event an admin must be able to query.
      this.deps.audit?.record({
        actorId: actor.userId,
        companyId: approval.companyId ?? actor.companyId,
        action: 'approval.inbox.unauthorized_actor',
        outcome: 'failure',
        metadata: { approvalId, decision, expectedApproverUserId: approverUserId ?? null, actorCompanyId: actor.companyId },
      });
      this.deps.logger.warn('approval_inbox.unauthorized_actor', { approvalId, actorUserId: actor.userId });
      return { ok: false, reason: 'forbidden', message: 'This request is waiting on someone else.' };
    }

    const resolved = await this.deps.approvals.atomicResolve(approvalId, decision, actor.userId);
    if (!resolved.ok || !resolved.value) {
      this.deps.logger.warn('approval_inbox.resolve_failed', { approvalId, decision });
      return { ok: false, reason: 'failed', message: 'Could not record that decision. Please try again.' };
    }

    const byName = actor.displayName ?? actor.userId;
    // The card, if one was delivered, must stop offering buttons for a decision
    // that has already been made somewhere else.
    if (approval.decisionMessageId && this.deps.onResolvedCard) {
      await this.deps.onResolvedCard(
        approval.decisionMessageId,
        decision,
        byName,
        resolutionCardRequest(approval),
      )
        .catch(error => this.deps.logger.warn('approval_inbox.card_update_failed', { approvalId, error: String(error) }));
    }

    // Gateway approvals are retried by the requester rather than resumed for
    // them; resuming those would execute an action nobody re-issued. Unless the
    // request says otherwise — one made from a form has no requester left to
    // re-issue it, and a yes that did nothing is the worse failure.
    if (!isGatewayApprovalMetadata(meta) || approvalResumesAutomatically(meta)) {
      void this.deps.resumer.resume(approvalId, decision)
        .catch(error => this.deps.logger.error('approval_inbox.resume_failed', { approvalId, error: String(error) }));
    }

    this.deps.audit?.record({
      actorId: actor.userId,
      companyId: approval.companyId ?? actor.companyId,
      action: 'approval.inbox.decided',
      outcome: 'success',
      metadata: { approvalId, decision, toolId: approval.toolId, actionGroup: approval.actionGroup },
    });
    this.deps.logger.info('approval_inbox.decided', { approvalId, decision, toolId: approval.toolId });

    return { ok: true, decision, item: present({ ...approval, status: decision }) };
  }
}

function present(row: RuntimeApprovalRow): ApprovalInboxItem {
  const meta = isRecord(row.metadataJson) ? row.metadataJson : {};
  const payload = isRecord(row.payloadJson) ? row.payloadJson : {};
  const args = 'args' in payload ? payload['args'] : payload;
  return {
    id: row.id,
    toolId: row.toolId,
    action: row.actionGroup,
    status: row.status,
    requestedAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    requestedByName: readString(meta['requesterEmail']) ?? readString(meta['requesterName']) ?? row.requestedBy ?? 'Someone',
    approverName: readString(meta['resolvedManagerName']) ?? 'your approver',
    departmentName: readString(meta['departmentName']) ?? null,
    deliveredVia: row.channel,
    description: describeToolAction(row.toolId, row.actionGroup, args),
    payload: args,
  };
}

function resolutionCardRequest(
  row: RuntimeApprovalRow,
): Omit<ApprovalCardInput, 'approvalId' | 'approverName'> {
  const meta = isRecord(row.metadataJson) ? row.metadataJson : {};
  const payload = isRecord(row.payloadJson) ? row.payloadJson : {};
  const authority = meta['approvalAuthority'];
  return {
    toolId: row.toolId,
    action: row.actionGroup,
    args: payload['args'],
    summary: row.summary,
    requesterName: readString(meta['requesterName'])
      ?? readString(meta['requesterEmail'])
      ?? 'A team member',
    authority: authority === 'connection_owner'
      || authority === 'company_admin'
      || authority === 'department_manager'
      ? authority
      : 'department_manager',
    departmentName: readString(meta['departmentName']) ?? 'Company-wide',
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
