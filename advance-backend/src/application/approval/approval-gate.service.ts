import type { ToolActionGroup } from '../../domain/permissions/tool-action-group';
import type { PermissionResult } from '../permissions/permission.types';
import type { RunContext } from '../../domain/orchestration/run-context';
import type { Logger } from '../../shared/logger';
import type { RuntimeApprovalRepository, RuntimeApprovalRow } from '../../infrastructure/persistence/runtime-approval.repository';
import type { ApprovalResolverService } from './approval-resolver.service';
import type { LarkChannelAdapter } from '../../infrastructure/channels/lark/lark.adapter';
import type {
  ApprovalAuthority,
  ApprovalDecision,
  ApprovalExecutionGrant,
  ApprovalRequestState,
} from './approval.types';
import type { ResolvedManager } from './approval.types';
import { checkApprovalPolicy, computeArgsHash, computeIdempotencyKey } from './approval-policy';
import { buildApprovalCard } from './approval-card-builder';
import { approvalOriginFromChatId } from './approval-origin';
import type { ConnectionRateLimitService } from '../governance/connection-rate-limit.service';
import {
  approvalDeliveryFailedCheckpoint,
  approvalDeliveryUnknownCheckpoint,
  isDefiniteApprovalNonDelivery,
} from './approval-delivery';
import type { KnowledgeMutationService } from '../knowledge/knowledge-mutation.service';
import { externalMailDestination } from '../mail-ops/external-destination';
import { inspectExternalForward } from '../mail-ops/external-forward-approval';

export type { ApprovalAuthority } from './approval.types';

export interface ApprovalGateInput {
  toolId:         string;
  action:         ToolActionGroup;
  args:           unknown;
  perm:           PermissionResult;
  runContext:     RunContext;
  /** Canonical conversation scope used for approval idempotency. */
  chatId:         string;
  /** Human-readable summary of what the tool call would do (shown on approval card). */
  argsSummary:    string;
  /** Optional, non-authoritative runtime execution provenance for audit/match checks. */
  execution?: {
    readonly version: 1;
    readonly threadId: string;
    readonly runId: string;
    readonly actionId: string;
  };
}

export interface ApprovalGateOptions {
  readonly disableManagerSelfBypass?: boolean;
  readonly knowledgeMutations?: Pick<
    KnowledgeMutationService,
    'get' | 'attachRuntimeApproval'
  >;
}

interface ApprovalCompatibilityScope {
  readonly chatId: string;
  readonly legacyAuthorityMetadata: boolean;
}

export type ApprovalRequirement =
  | { readonly kind: 'allowed' }
  | { readonly kind: 'misconfigured'; readonly message: string }
  | {
      readonly kind: 'required';
      readonly approver: ResolvedManager;
      readonly authority: 'department_manager';
      readonly connectionScope?: never;
    }
  | {
      readonly kind: 'required';
      readonly approver: ResolvedManager;
      readonly authority: 'company_admin';
      readonly connectionScope?: never;
    }
  | {
      readonly kind: 'required';
      readonly approver: ResolvedManager;
      readonly authority: 'connection_owner';
      readonly connectionScope: {
        readonly connectionId: string;
        readonly mode: 'connection_owner';
        readonly policySource: 'company_admin_override' | 'manager_policy';
      };
    }
  | {
      readonly kind: 'required';
      readonly approver: ResolvedManager;
      readonly authority: 'company_admin';
      readonly connectionScope: {
        readonly connectionId: string;
        readonly mode: 'company_admin';
        readonly policySource: 'company_admin_override' | 'manager_policy';
      };
    };

export class ApprovalGateService {
  constructor(
    private readonly approvalRepo:    RuntimeApprovalRepository,
    private readonly resolver:        ApprovalResolverService,
    private readonly larkAdapter:     LarkChannelAdapter,
    private readonly logger:          Logger,
    private readonly options:         ApprovalGateOptions = {},
    private readonly connectionRateLimits?: ConnectionRateLimitService,
  ) {}

  async check(input: ApprovalGateInput): Promise<ApprovalDecision> {
    const { toolId, action, args, perm, runContext, chatId, argsSummary, execution } = input;
    const requirement = await this.inspect({ toolId, action, args, perm, runContext });
    if (requirement.kind !== 'required') return requirement;
    const manager = requirement.approver;
    const requesterDisplay = await this.resolver.resolveUserDisplayName?.(
      String(runContext.userId),
    ) ?? runContext.requesterEmail ?? 'A team member';
    const departmentName = perm.department?.name ?? 'Company-wide';

    // Approval required. The authority and exact approver are part of the
    // idempotency namespace, so a policy/manager change cannot reuse an older
    // person's pending or approved decision.
    const argsHash      = computeArgsHash(args);
    const requesterId = String(runContext.userId);
    const departmentId = runContext.departmentId ? String(runContext.departmentId) : null;
    const sourceChatId = runContext.channel === 'lark' && runContext.chatId
      ? String(runContext.chatId)
      : chatId;
    const scopedChatId = approvalScopeKey(
      chatId,
      requirement,
      departmentId,
      requesterId,
    );
    const idemKey       = computeIdempotencyKey(scopedChatId, toolId, action, argsHash);
    // Always look under the run's own namespace as well as this caller's chat.
    // The request and the execution of the approved action come through
    // different call sites holding different chat ids, and only this one is the
    // same on both — see `executionApprovalChatId`.
    const executionScopes = execution
      ? [approvalScopeKey(
          executionApprovalChatId(runContext, execution),
          requirement,
          departmentId,
          requesterId,
        )]
      : [];
    const compatibilityScopes = approvalCompatibilityScopes(
      chatId,
      requirement,
      departmentId,
      scopedChatId,
      executionScopes,
    );
    const expectedApproval = {
      toolId,
      action,
      argsHash,
      runContext,
      chatId: scopedChatId,
      execution,
      authority: requirement.authority,
      approverUserId: requirement.approver.userId,
    };

    // Capture the current status bubble messageId so the resumer can edit
    // the same bubble in place (instead of creating a new one).
    const statusMessageId = runContext.traceId
      ? this.larkAdapter.getStatusMessageId(String(runContext.traceId))
      : undefined;

    // Atomically reuse a live request or create one. The repository serializes
    // this exact idempotency key across backend processes before creating a
    // row, which prevents duplicate Lark cards under concurrent retries.
    const createResult = await this.approvalRepo.createOrReuseActive(
      {
        chatId: scopedChatId,
        companyId:      String(runContext.companyId),
        toolId,
        actionGroup:    action,
        kind:           'tool_action',
        summary:        argsSummary,
        payloadJson:    { toolId, action, args, argsHash },
        metadataJson:   {
          requesterId,
          requesterName:          requesterDisplay,
          requesterEmail:         runContext.requesterEmail ?? null,
          requesterLarkOpenId:    runContext.channel === 'lark' && runContext.userExternalId
            ? String(runContext.userExternalId)
            : null,
          tenantKey:              runContext.channel === 'lark' && runContext.tenantId
            ? String(runContext.tenantId)
            : null,
          departmentId,
          departmentName,
          approvalOrigin:         runContext.channel === 'lark' && execution
            ? 'cloud_pi'
            : approvalOriginFromChatId(sourceChatId),
          statusMessageId:        statusMessageId ?? null,
          chatId: scopedChatId,
          sourceChatId,
          replyToMessageId:       runContext.replyToMessageId ?? null,
          replyInThread:          runContext.replyInThread ?? null,
          // Carried so the approved action executes under the same delivery
          // rules as the run that asked for it. Approval is checked before a
          // tool runs, so a scheduled run reaches this point with its guards
          // untested; rebuilding the context later without this would let the
          // approved call deliver where the run itself may not.
          deliveryMode:           runContext.deliveryMode ?? null,
          resolvedManagerOpenId:  manager.larkOpenId,
          resolvedManagerUserId:  manager.userId,
          resolvedManagerName:    manager.displayName,
          approvalAuthority:      requirement.authority,
          execution: execution ?? null,
        },
        // How this request will reach the approver. Lark when Divo can card
        // them, the desktop approval inbox when it cannot. The row is the
        // source of truth either way; delivery is a side effect of it.
        channel:        manager.larkOpenId ? 'lark' : 'desktop',
        requestedBy:    requesterId,
        idempotencyKey: idemKey,
        expiresAt:      new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
      {
        compatibleIdempotencyKeys: compatibilityScopes.map(scope =>
          computeIdempotencyKey(scope.chatId, toolId, action, argsHash)),
        isCompatibleApproval: approval => matchesApproval(
          approval,
          expectedApproval,
          compatibilityScopes,
        ),
      },
    );

    if (!createResult.ok) {
      this.logger.error('approval.gate.create_or_reuse_failed', { error: createResult.error.message });
      return { kind: 'misconfigured', message: 'Failed to create approval request. Please try again.' };
    }

    const { approval, created, replacedExpired } = createResult.value;
    const knowledgeBound = await this.bindKnowledgeApproval({
      toolId,
      args,
      runContext,
      approvalId: approval.id,
      authority: requirement.authority,
    });
    if (!knowledgeBound.ok) {
      await this.approvalRepo.markFailed(approval.id, 'knowledge_binding_failed');
      return { kind: 'misconfigured', message: knowledgeBound.message };
    }
    if (!created) {
      return this.decisionFromExisting({
        approval,
        requirement,
        toolId,
        action,
        argsHash,
        runContext,
        chatId: scopedChatId,
        compatibilityScopes,
        execution,
      });
    }

    // No card address — the request is live and waiting in their approval
    // inbox. This used to be `misconfigured`, which failed the tool call
    // outright and made a Lark account a precondition for approvals working
    // at all.
    if (!manager.larkOpenId) {
      this.logger.info('approval.gate.pending_created_inbox', {
        approvalId: approval.id,
        toolId,
        action,
        approver: manager.displayName,
      });
      return pendingDecision(
        approval.id,
        requirement,
        replacedExpired ? 'replaced_expired' : 'created',
        replacedExpired
          ? `The previous approval expired. ${manager.displayName} has a fresh request waiting in Divo (id: ${approval.id}).`
          : `${manager.displayName} has an approval request waiting in Divo. Waiting on their response (id: ${approval.id}).`,
      );
    }

    // Build and send the approval card to the manager
    const cardContent = buildApprovalCard({
      approvalId:     approval.id,
      toolId,
      action,
      args,
      summary:        argsSummary,
      requesterName:  requesterDisplay,
      approverName:   manager.displayName,
      authority:      requirement.authority,
      departmentName,
    });

    const sendResult = await this.larkAdapter.sendDirectCard(manager.larkOpenId, cardContent);
    if (!sendResult.ok) {
      this.logger.warn('approval.gate.card_send_failed', {
        approvalId: approval.id,
        error:      sendResult.error.message,
      });
      if (!isDefiniteApprovalNonDelivery(sendResult.error)) {
        const checkpoint = await this.approvalRepo.persistResult(
          approval.id,
          approvalDeliveryUnknownCheckpoint(sendResult.error.message),
        );
        if (!checkpoint.ok) {
          this.logger.error('approval.gate.delivery_unknown_checkpoint_failed', {
            approvalId: approval.id,
            error: checkpoint.error.message,
          });
        }
        return {
          kind: 'misconfigured',
          message: `Divo lost confirmation while delivering the approval card to ${manager.displayName}. The card may still be actionable, so the exact request is blocked from automatic retry (id: ${approval.id}). Please contact your administrator.`,
        };
      }
      const markFailed = await this.approvalRepo.markFailed(approval.id, `card_send_failed:${sendResult.error.message}`);
      if (!markFailed.ok) {
        this.logger.error('approval.gate.mark_failed_failed', {
          approvalId: approval.id,
          error:      markFailed.error.message,
        });
        const checkpoint = await this.approvalRepo.persistResult(
          approval.id,
          approvalDeliveryFailedCheckpoint(sendResult.error.message),
        );
        if (!checkpoint.ok) {
          this.logger.error('approval.gate.delivery_failure_checkpoint_failed', {
            approvalId: approval.id,
            error: checkpoint.error.message,
          });
        }
      }
      return {
        kind:    'misconfigured',
        message: 'This action requires manager approval, but the approval card could not be delivered. Please try again or contact your administrator.',
      };
    }

    // Persist the card message ID so the webhook can update it later.
    const delivered = await this.approvalRepo.setDecisionMessageId(approval.id, sendResult.value.messageId);
    if (!delivered.ok) {
      this.logger.error('approval.gate.delivery_persist_failed', {
        approvalId: approval.id,
        error: delivered.error.message,
      });
      // Sending succeeded. Keep the row as a durable dispatching barrier: the
      // card still carries its approval ID and can be resolved, while an exact
      // retry must never send a second card.
      return pendingDecision(
        approval.id,
        requirement,
        'dispatching',
        `The approval card reached ${manager.displayName}, but Divo is still syncing its delivery state (id: ${approval.id}). Do not create another request; the existing card remains usable.`,
      );
    }

    this.logger.info('approval.gate.pending_created', {
      approvalId: approval.id,
      toolId,
      action,
      manager:    manager.displayName,
    });

    return {
      kind:       'pending',
      approvalId: approval.id,
      message: replacedExpired
        ? `The previous approval expired. I've sent a fresh exact request to ${manager.displayName} (id: ${approval.id}).`
        : `I've sent an approval request to ${manager.displayName}. Waiting on their response (id: ${approval.id}).`,
      authority: requirement.authority,
      approverName: manager.displayName,
      requestState: replacedExpired ? 'replaced_expired' : 'created',
      nextAction: 'wait',
      retry: 'retry_exact',
    };
  }

  /**
   * Resolve the human authority for an exact action without creating or
   * claiming an approval. Batch planning and ordinary tool execution share
   * this path so connection policy can never select two different approvers.
   */
  async inspect(input: Pick<ApprovalGateInput, 'toolId' | 'action' | 'args' | 'perm' | 'runContext'>): Promise<ApprovalRequirement> {
    const { toolId, action, args, perm, runContext } = input;
    const knowledgeRequirement = await this.inspectKnowledgeMutation(input);
    if (knowledgeRequirement) return knowledgeRequirement;

    const exfiltrationRequirement = await this.inspectExternalMailForward(input);
    if (exfiltrationRequirement) return exfiltrationRequirement;

    const policyResult = checkApprovalPolicy({ toolId, action, args, perm, runContext });
    const connectionId = connectionIdFromArgs(args);
    const connectionPolicy = this.connectionRateLimits
      ? await this.connectionRateLimits.approval({
        companyId: String(runContext.companyId),
        ...(connectionId ? { connectionId } : {}),
        action,
      })
      : { kind: 'not_governed' as const };
    if (connectionPolicy.kind === 'unavailable') {
      return { kind: 'misconfigured', message: connectionPolicy.message };
    }

    const connectionOverridesDepartment = connectionPolicy.kind === 'required' || connectionPolicy.kind === 'not_required';
    if (policyResult.misconfigured && !connectionOverridesDepartment) {
      this.logger.warn('approval.gate.policy_misconfigured', { toolId, action });
      return { kind: 'misconfigured', message: policyResult.misconfigured };
    }

    if (connectionPolicy.kind === 'required') {
      const approver = await this.resolveConnectionApprover(
        connectionPolicy.mode,
        connectionId!,
        String(runContext.companyId),
      );
      if (!approver) {
        return {
          kind: 'misconfigured',
          message: connectionPolicy.mode === 'connection_owner'
            ? 'This shared connection requires its owner to approve the action, but the owner has no connected Lark account.'
            : 'This connection requires company-admin approval, but no company admin has a connected Lark account.',
        };
      }
      if (!this.options.disableManagerSelfBypass && String(runContext.userId) === approver.userId) {
        this.logger.info('approval.gate.connection_owner_self_bypass', { userId: runContext.userId, toolId, action });
        return { kind: 'allowed' };
      }
      return connectionPolicy.mode === 'connection_owner'
        ? {
            kind: 'required',
            approver,
            authority: 'connection_owner',
            connectionScope: {
              connectionId: connectionId!,
              mode: 'connection_owner',
              policySource: connectionPolicy.policySource,
            },
          }
        : {
            kind: 'required',
            approver,
            authority: 'company_admin',
            connectionScope: {
              connectionId: connectionId!,
              mode: 'company_admin',
              policySource: connectionPolicy.policySource,
            },
          };
    }

    if (connectionOverridesDepartment || !policyResult.required) return { kind: 'allowed' };
    const departmentId = perm.department?.id;
    if (!departmentId) {
      this.logger.warn('approval.gate.no_dept', { toolId, action });
      return { kind: 'misconfigured', message: 'No department context — cannot resolve approver.' };
    }
    const approver = await this.resolver.resolveManager(String(departmentId), String(runContext.companyId));
    if (!approver) {
      this.logger.warn('approval.gate.no_manager', { departmentId, companyId: runContext.companyId });
      return {
        kind: 'misconfigured',
        message: 'This action requires manager approval but no approver is configured for this department. Please contact your administrator.',
      };
    }
    if (!this.options.disableManagerSelfBypass && String(runContext.userId) === approver.userId) {
      this.logger.info('approval.gate.self_bypass', { userId: runContext.userId, toolId, action });
      return { kind: 'allowed' };
    }
    return { kind: 'required', approver, authority: 'department_manager' };
  }

  /**
   * A standing forward out of the company is approved by a person, always.
   *
   * A mail rule ships the whole original message, and creation goes through
   * the model, so an instruction hidden in an earlier tool result could set one
   * up silently. Everything else about that rule is governed by policy a
   * manager may or may not have configured; this one does not wait to be
   * switched on.
   *
   * The decision itself lives in `mail-ops/external-forward-approval`, because
   * a member creating the identical rule in a browser never reaches this class
   * and must get the same answer. What stays here is the part that is genuinely
   * the gate's: reading arguments the model supplied, and speaking in
   * `ApprovalRequirement`.
   */
  private async inspectExternalMailForward(
    input: Pick<ApprovalGateInput, 'toolId' | 'action' | 'args' | 'perm' | 'runContext'>,
  ): Promise<ApprovalRequirement | null> {
    if (input.toolId !== 'mailAutomations') return null;
    const destination = externalMailDestination({
      args: input.args,
      requesterEmail: input.runContext.requesterEmail,
    });
    if (!destination) return null;

    const verdict = await inspectExternalForward(
      {
        destination,
        companyId: String(input.runContext.companyId),
        requesterId: String(input.runContext.userId),
        departmentId: input.runContext.departmentId
          ? String(input.runContext.departmentId)
          : input.perm.department?.id
            ? String(input.perm.department.id)
            : null,
      },
      {
        resolveManager: (departmentId, companyId, options) =>
          this.resolver.resolveManager(departmentId, companyId, options),
        disableManagerSelfBypass: this.options.disableManagerSelfBypass,
        onSelfBypass: (bypassed) => {
          this.logger.info('approval.gate.external_mail_forward_self_bypass', bypassed);
        },
      },
    );

    if (verdict.kind === 'not_external') return null;
    if (verdict.kind === 'allowed') return { kind: 'allowed' };
    if (verdict.kind === 'misconfigured') {
      return { kind: 'misconfigured', message: verdict.message };
    }
    return { kind: 'required', approver: verdict.approver, authority: 'department_manager' };
  }

  private async inspectKnowledgeMutation(
    input: Pick<ApprovalGateInput, 'toolId' | 'action' | 'args' | 'perm' | 'runContext'>,
  ): Promise<ApprovalRequirement | null> {
    if (input.toolId !== 'knowledge') return null;
    const parsed = knowledgeApplyArgs(input.args);
    if (!parsed) {
      // Target discovery and proposal creation have no provider side effect and
      // never enter the authority-approval stage.
      return isKnowledgeNonApply(input.args)
        ? { kind: 'allowed' }
        : { kind: 'misconfigured', message: 'Invalid knowledge apply request.' };
    }
    if (!this.options.knowledgeMutations) {
      return { kind: 'misconfigured', message: 'The knowledge authority is not configured.' };
    }

    let mutation: Awaited<ReturnType<KnowledgeMutationService['get']>>;
    try {
      mutation = await this.options.knowledgeMutations.get({
        mutationId: parsed.mutationId,
        companyId: String(input.runContext.companyId),
      });
    } catch {
      return { kind: 'misconfigured', message: 'The exact knowledge proposal could not be resolved.' };
    }

    const expectedAction = mutation.action === 'publish' ? 'create' : mutation.action;
    const requestedDepartmentId = parsed.scope === 'department' ? parsed.departmentId : null;
    if (
      input.action !== expectedAction
      || mutation.requesterId !== String(input.runContext.userId)
      || mutation.kind !== parsed.kind
      || mutation.action !== parsed.action
      || mutation.scope !== parsed.scope
      || mutation.departmentId !== requestedDepartmentId
      || mutation.proposedContentHash !== parsed.contentHash
    ) {
      return { kind: 'misconfigured', message: 'The knowledge apply request does not match the reviewed proposal.' };
    }

    if (mutation.requiredAuthority === 'none') {
      return mutation.status === 'approved' || mutation.status === 'applied'
        ? { kind: 'allowed' }
        : { kind: 'misconfigured', message: 'This personal proposal is still waiting for its owner review.' };
    }
    if (!mutation.requesterReviewedAt) {
      return { kind: 'misconfigured', message: 'The requester must review the exact content before it reaches an approver.' };
    }
    if (!['awaiting_approval', 'approved', 'applied'].includes(mutation.status)) {
      return { kind: 'misconfigured', message: 'This knowledge proposal is no longer eligible for approval.' };
    }

    if (mutation.requiredAuthority === 'department_manager') {
      if (
        !mutation.departmentId
        || mutation.departmentId !== String(input.runContext.departmentId ?? '')
        || mutation.departmentId !== String(input.perm.department?.id ?? '')
      ) {
        return { kind: 'misconfigured', message: 'The proposal is outside the authenticated department context.' };
      }
      const approver = await this.resolver.resolveManager(
        mutation.departmentId,
        mutation.companyId,
        {
          excludeUserId: mutation.requesterId,
          allowCompanyAdminFallback: false,
        },
      );
      return approver
        ? { kind: 'required', approver, authority: 'department_manager' }
        : {
            kind: 'misconfigured',
            message: 'A different active department manager is required, but none is configured.',
          };
    }

    const approver = await this.resolver.resolveCompanyAdmin(
      mutation.companyId,
      { excludeUserId: mutation.requesterId },
    );
    return approver
      ? { kind: 'required', approver, authority: 'company_admin' }
      : {
          kind: 'misconfigured',
          message: 'A different company admin is required, but none is configured.',
        };
  }

  private async bindKnowledgeApproval(input: {
    toolId: string;
    args: unknown;
    runContext: RunContext;
    approvalId: string;
    authority: ApprovalAuthority;
  }): Promise<{ ok: true } | { ok: false; message: string }> {
    if (input.toolId !== 'knowledge') return { ok: true };
    const parsed = knowledgeApplyArgs(input.args);
    if (!parsed || !this.options.knowledgeMutations) {
      return { ok: false, message: 'The knowledge approval could not be bound to its proposal.' };
    }
    if (input.authority !== 'department_manager' && input.authority !== 'company_admin') {
      return { ok: false, message: 'The knowledge approval resolved an invalid authority.' };
    }
    try {
      const mutation = await this.options.knowledgeMutations.get({
        mutationId: parsed.mutationId,
        companyId: String(input.runContext.companyId),
      });
      if (mutation.runtimeApprovalId === input.approvalId) return { ok: true };
      if (mutation.runtimeApprovalId) {
        return { ok: false, message: 'This knowledge proposal is already bound to a different approval.' };
      }
      await this.options.knowledgeMutations.attachRuntimeApproval({
        mutationId: mutation.id,
        companyId: mutation.companyId,
        requesterId: String(input.runContext.userId),
        expectedContentHash: parsed.contentHash,
        approvalId: input.approvalId,
        authority: input.authority,
      });
      return { ok: true };
    } catch {
      return { ok: false, message: 'The knowledge approval could not be durably bound to its exact proposal.' };
    }
  }

  private async resolveConnectionApprover(
    mode: 'connection_owner' | 'company_admin',
    connectionId: string,
    companyId: string,
  ): Promise<ResolvedManager | null> {
    return mode === 'connection_owner'
      ? this.resolver.resolveConnectionOwner(connectionId, companyId)
      : this.resolver.resolveCompanyAdmin(companyId);
  }

  async completeExecution(grant: ApprovalExecutionGrant, resultJson: unknown): Promise<boolean> {
    const result = await this.approvalRepo.completeApprovedExecution(grant.approvalId, resultJson);
    if (result.ok && result.value) return true;
    if (!result.ok || !result.value) {
      this.logger.error('approval.gate.complete_execution_failed', {
        approvalId: grant.approvalId,
        error:      result.ok ? 'approval_not_executing' : result.error.message,
      });
    }
    return this.persistTerminalFallback(grant, resultJson, 'complete');
  }

  async failExecution(grant: ApprovalExecutionGrant, resultJson: unknown): Promise<boolean> {
    const result = await this.approvalRepo.failApprovedExecution(grant.approvalId, resultJson);
    if (result.ok && result.value) return true;
    if (!result.ok || !result.value) {
      this.logger.error('approval.gate.fail_execution_failed', {
        approvalId: grant.approvalId,
        error:      result.ok ? 'approval_not_executing' : result.error.message,
      });
    }
    return this.persistTerminalFallback(grant, resultJson, 'fail');
  }

  async releaseExecution(grant: ApprovalExecutionGrant): Promise<boolean> {
    const result = await this.approvalRepo.releaseApprovedExecution(grant.approvalId);
    if (!result.ok || !result.value) {
      this.logger.error('approval.gate.release_execution_failed', {
        approvalId: grant.approvalId,
        ...(!result.ok ? { error: result.error.message } : { error: 'approval_not_executing' }),
      });
      return false;
    }
    this.logger.info('approval.gate.execution_released', { approvalId: grant.approvalId });
    return true;
  }

  private async persistTerminalFallback(
    grant: ApprovalExecutionGrant,
    resultJson: unknown,
    terminal: 'complete' | 'fail',
  ): Promise<boolean> {
    const checkpoint = await this.approvalRepo.persistExecutingResult(grant.approvalId, resultJson);
    if (checkpoint.ok && checkpoint.value) {
      this.logger.warn('approval.gate.terminal_checkpointed', {
        approvalId: grant.approvalId,
        terminal,
      });
      return true;
    }
    this.logger.error('approval.gate.terminal_checkpoint_failed', {
      approvalId: grant.approvalId,
      terminal,
      error: checkpoint.ok ? 'approval_not_executing' : checkpoint.error.message,
    });
    return false;
  }

  private async claimApprovedGrant(input: {
    approval:   RuntimeApprovalRow;
    toolId:     string;
    action:     ToolActionGroup;
    argsHash:   string;
    runContext: RunContext;
    chatId:     string;
    compatibilityScopes: readonly ApprovalCompatibilityScope[];
    execution?: ApprovalGateInput['execution'];
    authority: ApprovalAuthority;
    approverUserId: string;
  }): Promise<ApprovalDecision> {
    const {
      approval,
      toolId,
      action,
      argsHash,
      runContext,
      chatId,
      compatibilityScopes,
      execution,
      authority,
      approverUserId,
    } = input;

    if (!matchesApproval(approval, {
      toolId,
      action,
      argsHash,
      runContext,
      chatId,
      execution,
      authority,
      approverUserId,
    }, compatibilityScopes)) {
      this.logger.warn('approval.gate.approved_grant_mismatch', { approvalId: approval.id, toolId, action });
      return {
        kind: 'misconfigured',
        message: 'The approved action no longer matches this request. Please ask for approval again.',
      };
    }

    const claimResult = await this.approvalRepo.claimApprovedExecution(approval.id, String(runContext.userId));
    if (!claimResult.ok) {
      this.logger.error('approval.gate.claim_failed', { approvalId: approval.id, error: claimResult.error.message });
      return { kind: 'misconfigured', message: 'Failed to claim the approved action. Please try again.' };
    }

    if (!claimResult.value) {
      const current = await this.approvalRepo.findById(approval.id);
      if (current.ok && current.value?.status === 'executing') {
        this.logger.info('approval.gate.execution_already_in_progress', { approvalId: approval.id });
        return {
          kind: 'pending',
          approvalId: approval.id,
          message: `The approved action is already executing (id: ${approval.id}). Wait for it to finish; do not retry it.`,
          authority,
          approverName: approverNameFromApproval(approval),
          requestState: 'reused',
          nextAction: 'wait',
          retry: 'retry_exact',
        };
      }
      if (current.ok && current.value?.status === 'consumed') {
        return completedDecision(current.value);
      }
      this.logger.warn('approval.gate.claim_unavailable', {
        approvalId: approval.id,
        currentStatus: current.ok ? current.value?.status : 'lookup_failed',
      });
      return {
        kind: 'misconfigured',
        message: 'This approval has already been used or expired. Please ask for approval again.',
      };
    }

    this.logger.info('approval.gate.approved_grant_claimed', { approvalId: approval.id, toolId, action });
    return {
      kind: 'allowed',
      executionGrant: {
        approvalId: approval.id,
        authority,
      },
    };
  }

  private decisionFromExisting(input: {
    approval: RuntimeApprovalRow;
    requirement: Extract<ApprovalRequirement, { kind: 'required' }>;
    toolId: string;
    action: ToolActionGroup;
    argsHash: string;
    runContext: RunContext;
    chatId: string;
    compatibilityScopes: readonly ApprovalCompatibilityScope[];
    execution?: ApprovalGateInput['execution'];
  }): Promise<ApprovalDecision> | ApprovalDecision {
    const { approval, requirement } = input;
    const expected = {
      toolId: input.toolId,
      action: input.action,
      argsHash: input.argsHash,
      runContext: input.runContext,
      chatId: input.chatId,
      execution: input.execution,
      authority: requirement.authority,
      approverUserId: requirement.approver.userId,
    };
    if (!matchesApproval(approval, expected, input.compatibilityScopes)) {
      this.logger.warn('approval.gate.existing_mismatch', {
        approvalId: approval.id,
        toolId: input.toolId,
        action: input.action,
      });
      return {
        kind: 'misconfigured',
        message: 'The existing approval belongs to a different requester or authority. A new exact request is required.',
      };
    }

    if (approval.status === 'approved') {
      return this.claimApprovedGrant({
        approval,
        toolId: input.toolId,
        action: input.action,
        argsHash: input.argsHash,
        runContext: input.runContext,
        chatId: input.chatId,
        compatibilityScopes: input.compatibilityScopes,
        execution: input.execution,
        authority: requirement.authority,
        approverUserId: requirement.approver.userId,
      });
    }

    if (approval.status === 'executing') {
      const checkpoint = terminalCheckpointDecision(approval, requirement);
      if (checkpoint) return checkpoint;
      return {
        kind: 'pending',
        approvalId: approval.id,
        message: `The approved action is already executing (id: ${approval.id}). Wait for it to finish; do not retry it.`,
        authority: requirement.authority,
        approverName: requirement.approver.displayName,
        requestState: 'reused',
        nextAction: 'wait',
        retry: 'retry_exact',
      };
    }

    if (approval.status === 'consumed') {
      return completedDecision(approval);
    }

    if (approval.status === 'pending') {
      this.logger.info('approval.gate.idempotent_pending', {
        approvalId: approval.id,
        toolId: input.toolId,
        action: input.action,
      });
      return pendingDecision(
        approval.id,
        requirement,
        'reused',
        `This exact action is still waiting for ${requirement.approver.displayName} (id: ${approval.id}). The existing request was reused; no new card was sent.`,
      );
    }

    if (approval.status === 'dispatching') {
      const delivery = isRecord(approval.executionResultJson)
        ? approval.executionResultJson
        : {};
      if (delivery['status'] === 'approval_delivery_failed') {
        return {
          kind: 'misconfigured',
          message: `The approval request was definitely not delivered (id: ${approval.id}). Retry the exact same action; Divo will safely replace this failed delivery without duplicating a card.`,
        };
      }
      if (delivery['status'] === 'approval_delivery_unknown') {
        return {
          kind: 'misconfigured',
          message: `Divo lost confirmation while delivering this approval request (id: ${approval.id}). The card may still be actionable, so the exact request is blocked from automatic retry. Please contact your administrator.`,
        };
      }
      return pendingDecision(
        approval.id,
        requirement,
        'dispatching',
        `Divo is still delivering this exact approval request to ${requirement.approver.displayName} (id: ${approval.id}). Wait; no duplicate card was sent.`,
      );
    }

    if (approval.status === 'failed') {
      return {
        kind: 'execution_failed',
        approvalId: approval.id,
        message: `The previously approved action failed after execution began (id: ${approval.id}). Its provider outcome may be uncertain, so Divo will not run the exact same action again. Inspect the destination, then change the request before retrying.`,
        authority: requirement.authority,
        approverName: requirement.approver.displayName,
        requestState: 'reused',
        nextAction: 'change_request',
        retry: 'change_request',
      };
    }

    return {
      kind: 'rejected',
      approvalId: approval.id,
      message: `This exact action was rejected by ${requirement.approver.displayName} (id: ${approval.id}). Change the request before asking again.`,
      authority: requirement.authority,
      approverName: requirement.approver.displayName,
      requestState: 'reused',
      nextAction: 'change_request',
      retry: 'change_request',
    };
  }
}

interface KnowledgeApplyArgs {
  readonly mutationId: string;
  readonly contentHash: string | null;
  readonly kind: 'memory' | 'skill' | 'file';
  readonly action: 'create' | 'update' | 'publish' | 'delete';
  readonly scope: 'personal' | 'department' | 'company';
  readonly departmentId: string | null;
}

function knowledgeApplyArgs(value: unknown): KnowledgeApplyArgs | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const args = value as Record<string, unknown>;
  if (args['operation'] !== 'apply') return null;
  const mutationId = args['mutationId'];
  const contentHash = args['contentHash'];
  const kind = args['kind'];
  const action = args['action'];
  const scope = args['scope'];
  const departmentId = args['departmentId'];
  if (
    typeof mutationId !== 'string'
    || (contentHash !== null && typeof contentHash !== 'string')
    || (kind !== 'memory' && kind !== 'skill' && kind !== 'file')
    || (action !== 'create' && action !== 'update' && action !== 'publish' && action !== 'delete')
    || (scope !== 'personal' && scope !== 'department' && scope !== 'company')
    || (scope === 'department' && typeof departmentId !== 'string')
    || (scope !== 'department' && departmentId !== undefined)
  ) return null;
  return {
    mutationId,
    contentHash: contentHash ?? null,
    kind,
    action,
    scope,
    departmentId: scope === 'department' ? departmentId as string : null,
  };
}

function isKnowledgeNonApply(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const operation = (value as Record<string, unknown>)['operation'];
  return operation === 'check_targets' || operation === 'recall' || operation === 'propose';
}

function completedDecision(
  approval: RuntimeApprovalRow,
): Extract<ApprovalDecision, { kind: 'completed' }> {
  const stored = isRecord(approval.executionResultJson)
    ? approval.executionResultJson
    : {};
  return {
    kind: 'completed',
    approvalId: approval.id,
    result: Object.hasOwn(stored, 'result') ? stored['result'] : approval.executionResultJson,
  };
}

function terminalCheckpointDecision(
  approval: RuntimeApprovalRow,
  requirement: Extract<ApprovalRequirement, { kind: 'required' }>,
): ApprovalDecision | null {
  if (approval.kind !== 'tool_action' || !isRecord(approval.executionResultJson)) return null;
  const status = approval.executionResultJson['status'];
  if (status === 'success') return completedDecision(approval);
  if (typeof status !== 'string') return null;
  return {
    kind: 'execution_failed',
    approvalId: approval.id,
    message: `The previously approved action reached the provider but Divo could not finish its durable checkpoint (id: ${approval.id}). The exact action will not run again. Inspect the destination, then change the request before retrying.`,
    authority: requirement.authority,
    approverName: requirement.approver.displayName,
    requestState: 'reused',
    nextAction: 'change_request',
    retry: 'change_request',
  };
}

function approverNameFromApproval(approval: RuntimeApprovalRow): string {
  const metadata = isRecord(approval.metadataJson) ? approval.metadataJson : {};
  return typeof metadata['resolvedManagerName'] === 'string'
    ? metadata['resolvedManagerName']
    : 'the configured approver';
}

function isExactApprovalMatch(
  approval: RuntimeApprovalRow,
  expected: {
    toolId:     string;
    action:     ToolActionGroup;
    argsHash:   string;
    runContext: RunContext;
    chatId:     string;
    execution?: ApprovalGateInput['execution'];
    authority: ApprovalAuthority;
    approverUserId: string;
  },
): boolean {
  const payload = isRecord(approval.payloadJson) ? approval.payloadJson : {};
  const meta = isRecord(approval.metadataJson) ? approval.metadataJson : {};

  const expectedDepartmentId = expected.runContext.departmentId ? String(expected.runContext.departmentId) : null;

  return approval.toolId === expected.toolId
    && approval.actionGroup === expected.action
    && approval.requestedBy === String(expected.runContext.userId)
    && payload['toolId'] === expected.toolId
    && payload['action'] === expected.action
    && payload['argsHash'] === expected.argsHash
    && meta['requesterId'] === String(expected.runContext.userId)
    && meta['chatId'] === expected.chatId
    && (meta['departmentId'] ?? null) === expectedDepartmentId
    && meta['approvalAuthority'] === expected.authority
    && meta['resolvedManagerUserId'] === expected.approverUserId
    && executionMetadataMatches(meta['execution'], expected.execution);
}

function matchesApproval(
  approval: RuntimeApprovalRow,
  expected: Parameters<typeof isExactApprovalMatch>[1],
  compatibilityScopes: readonly ApprovalCompatibilityScope[],
): boolean {
  if (isExactApprovalMatch(approval, expected)) return true;
  return compatibilityScopes.some(scope => {
    const compatibleExpected = { ...expected, chatId: scope.chatId };
    return scope.legacyAuthorityMetadata
      ? isLegacyApprovalMatch(approval, compatibleExpected)
      : isExactApprovalMatch(approval, compatibleExpected);
  });
}

function isLegacyApprovalMatch(
  approval: RuntimeApprovalRow,
  expected: Parameters<typeof isExactApprovalMatch>[1],
): boolean {
  const payload = isRecord(approval.payloadJson) ? approval.payloadJson : {};
  const meta = isRecord(approval.metadataJson) ? approval.metadataJson : {};
  const expectedDepartmentId = expected.runContext.departmentId
    ? String(expected.runContext.departmentId)
    : null;

  return approval.toolId === expected.toolId
    && approval.actionGroup === expected.action
    && approval.requestedBy === String(expected.runContext.userId)
    && payload['toolId'] === expected.toolId
    && payload['action'] === expected.action
    && payload['argsHash'] === expected.argsHash
    && meta['requesterId'] === String(expected.runContext.userId)
    && meta['chatId'] === expected.chatId
    && (meta['departmentId'] ?? null) === expectedDepartmentId
    && meta['approvalAuthority'] === undefined
    && meta['resolvedManagerUserId'] === expected.approverUserId
    && executionMetadataMatches(meta['execution'], expected.execution);
}

function approvalScopeKey(
  chatId: string,
  requirement: Extract<ApprovalRequirement, { kind: 'required' }>,
  departmentId: string | null,
  requesterId: string,
): string {
  const authority = `${requirement.authority}:${requirement.approver.userId}`;
  if (!requirement.connectionScope) {
    // A manager can own more than one department. Keep those approval
    // namespaces distinct because the exact-match check also binds the
    // department and policy may differ between them.
    return `${chatId}:requester:${requesterId}:approval:${authority}:department:${departmentId ?? 'none'}`;
  }
  const scope = requirement.connectionScope;
  return [
    chatId,
    'requester',
    requesterId,
    'approval',
    authority,
    scope.connectionId,
    scope.mode,
    scope.policySource,
  ].join(':');
}

/**
 * The approval namespace a run owns, independent of which chat id the caller
 * happened to hold.
 *
 * The gateway scopes an approval by run — `gateway:company:…:thread:…:run:…` —
 * so one manager decision cannot be spent by a different turn. The runtime
 * executor that runs the *approved* action scopes by the plain conversation id
 * instead. Both are reached through the same tool executor, in that order, for
 * every Lark request.
 *
 * So the two never agreed on where to look, and the exact-match check compares
 * the stored scope. An approval requested through the gateway could therefore
 * never be claimed: the manager approved it, execution asked the gate again,
 * the gate found nothing under its own scope and opened a second request —
 * which the requester was then told to wait for, forever. Anish's first mail
 * rule produced three approval rows in sixty-five seconds, identical in every
 * field including `argsHash` and `runId`, differing only here.
 *
 * Derived from `execution`, which both paths already carry, so it is the one
 * name the request and its execution can agree on.
 */
function executionApprovalChatId(
  runContext: RunContext,
  execution: NonNullable<ApprovalGateInput['execution']>,
): string {
  return [
    'gateway',
    'company',
    String(runContext.companyId),
    'requester',
    String(runContext.userId),
    'thread',
    execution.threadId,
    'run',
    execution.runId,
  ].join(':');
}

function approvalCompatibilityScopes(
  chatId: string,
  requirement: Extract<ApprovalRequirement, { kind: 'required' }>,
  departmentId: string | null,
  currentChatId: string,
  /**
   * Already-scoped ids to look under as well as this chat's own.
   *
   * These arrive through `approvalScopeKey` like the primary, so they carry
   * the same authority, requester and department binding — a wider search, not
   * a weaker check.
   */
  extraScopedChatIds: readonly string[] = [],
): ApprovalCompatibilityScope[] {
  const authority = `${requirement.authority}:${requirement.approver.userId}`;
  const previousWaveChatId = requirement.connectionScope
    ? [
        chatId,
        'approval',
        authority,
        requirement.connectionScope.connectionId,
        requirement.connectionScope.mode,
        requirement.connectionScope.policySource,
      ].join(':')
    : `${chatId}:approval:${authority}:department:${departmentId ?? 'none'}`;
  const legacyChatId = requirement.connectionScope
    ? [
        chatId,
        'connection',
        requirement.connectionScope.connectionId,
        requirement.connectionScope.mode,
        requirement.connectionScope.policySource,
      ].join(':')
    : chatId;

  const scopes: ApprovalCompatibilityScope[] = [
    ...extraScopedChatIds.map(scoped => ({
      chatId: scoped,
      legacyAuthorityMetadata: false,
    })),
    { chatId: previousWaveChatId, legacyAuthorityMetadata: false },
    { chatId: legacyChatId, legacyAuthorityMetadata: true },
  ];
  return scopes.filter((scope, index) =>
    scope.chatId !== currentChatId
    && scopes.findIndex(candidate =>
      candidate.chatId === scope.chatId
      && candidate.legacyAuthorityMetadata === scope.legacyAuthorityMetadata) === index);
}

function pendingDecision(
  approvalId: string,
  requirement: Extract<ApprovalRequirement, { kind: 'required' }>,
  requestState: ApprovalRequestState,
  message: string,
): Extract<ApprovalDecision, { kind: 'pending' }> {
  return {
    kind: 'pending',
    approvalId,
    message,
    authority: requirement.authority,
    approverName: requirement.approver.displayName,
    requestState,
    nextAction: 'wait',
    retry: 'retry_exact',
  };
}

function executionMetadataMatches(
  actual: unknown,
  expected: ApprovalGateInput['execution'],
): boolean {
  if (!expected) return actual === null || actual === undefined;
  if (!isRecord(actual)) return false;
  // Retrying an approved manager-gated request creates a fresh Pi tool-call
  // ID, but it must remain usable for the same exact desktop run and args.
  // `chatId` already carries that thread/run partition and argsHash is checked
  // above. actionId remains audit-only here; local approval intents bind it
  // strictly because their prepare/commit pair never creates a new tool call.
  return actual['version'] === expected.version
    && actual['threadId'] === expected.threadId
    && actual['runId'] === expected.runId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function connectionIdFromArgs(args: unknown): string | undefined {
  if (!isRecord(args)) return undefined;
  const value = args['connectionId'];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}
