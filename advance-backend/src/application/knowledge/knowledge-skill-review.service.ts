import { computeArgsHash } from '../approval/approval-policy';
import type { ApprovalGateService } from '../approval/approval-gate.service';
import type { ApprovalResolverService } from '../approval/approval-resolver.service';
import type {
  DecisionActor,
  DecisionService,
  SettleOutcome,
} from '../decision/decision.service';
import type { PermissionService } from '../permissions/permission.service';
import type { PermissionResult } from '../permissions/permission.types';
import type { ToolExecutor } from '../gateway/tool-executor';
import type {
  GatewayExecutionContext,
  GatewayMemberContext,
} from '../gateway/gateway.types';
import type { KnowledgeProjectionService } from './knowledge-projection.service';
import type { KnowledgeMutationService } from './knowledge-mutation.service';
import type { KnowledgeResourceQueryService } from './knowledge-resource-query.service';
import type { KnowledgeMutationRecord } from '../../domain/knowledge/knowledge-mutation';
import type {
  RuntimeApprovalRepository,
  RuntimeApprovalRow,
} from '../../infrastructure/persistence/runtime-approval.repository';
import type { ChannelIdentityRepoPort } from '../../infrastructure/persistence/channel-identity.repository';
import type { Logger } from '../../shared/logger';
import { asCompanyId, asDepartmentId, asUserId } from '../../shared/ids';
import { asCompanyRoleSlug } from '../../domain/permissions/company-role';
import type { DecisionAnswer } from '../../domain/decision/decision';
import type { RunContext } from '../../domain/orchestration/run-context';
import { KnowledgeMutationError } from './knowledge-mutation.errors';
import {
  assertLarkReviewableSkill,
  buildSkillChangeEvidence,
} from './knowledge-review-presentation';

export const KNOWLEDGE_SKILL_REVIEW_ROW_KIND = 'knowledge_skill_review';

export interface KnowledgeSkillReviewRequest {
  readonly requestId: string;
  readonly action: 'create' | 'update' | 'publish' | 'delete';
  readonly scope: 'personal' | 'department' | 'company';
  readonly logicalKey: string;
  readonly baseVersion?: number;
  readonly content?: unknown;
}

export type OpenKnowledgeSkillReviewOutcome =
  | {
      readonly ok: true;
      readonly mutationId: string;
      readonly decisionId: string;
      readonly reused: boolean;
      readonly state: 'review_pending' | 'waiting_authority' | 'applied' | 'projection_queued';
      readonly message: string;
    }
  | {
      readonly ok: false;
      readonly reason: 'invalid' | 'permission_denied' | 'unavailable' | 'failed';
      readonly message: string;
    };

export interface LinkedDecisionOutcome {
  readonly parentDecisionId: string;
  readonly approvalId: string;
  readonly status: 'completed' | 'rejected' | 'failed';
  readonly result: unknown;
}

/**
 * The durable lifecycle for one correction-driven skill mutation.
 *
 * Callers provide authenticated identity, runtime provenance, and the exact
 * replacement. This module owns every transition after that: proposal,
 * requester Decision, authority hand-off, apply, projection, and terminal
 * linked outcome. Web and Lark are adapters at its interface, not workflow
 * stores.
 */
export class KnowledgeSkillReviewService {
  private readonly log: Logger;

  constructor(private readonly deps: {
    readonly mutations: KnowledgeMutationService;
    readonly projections: KnowledgeProjectionService;
    readonly resources: Pick<KnowledgeResourceQueryService, 'get'>;
    readonly decisions: Pick<DecisionService, 'ask'>;
    readonly approvals: RuntimeApprovalRepository;
    readonly permissions: PermissionService;
    readonly tools: ToolExecutor;
    readonly approvalGate: ApprovalGateService;
    readonly approvalResolver: ApprovalResolverService;
    readonly identities?: Pick<ChannelIdentityRepoPort, 'resolveByLarkTenantIdentity'>;
    readonly transcript?: {
      appendTurn(
        threadId: string,
        turn: { role: 'assistant'; content: string; timestamp: string },
        scope: { companyId: string; channel: 'web' },
        metadata?: { dedupeKey?: string },
      ): Promise<unknown>;
    };
    readonly outcomeDelivery?: {
      deliver(decisionId: string): Promise<void>;
      deliverPending(limit?: number): Promise<void>;
    };
    readonly logger: Logger;
  }) {
    this.log = deps.logger.child({ module: 'knowledge-skill-review' });
  }

  async open(input: {
    readonly member: GatewayMemberContext;
    readonly departmentId?: string;
    readonly execution: GatewayExecutionContext;
    readonly request: KnowledgeSkillReviewRequest;
  }): Promise<OpenKnowledgeSkillReviewOutcome> {
    const channel = input.member.channel;
    if (channel !== 'web' && channel !== 'lark') {
      return { ok: false, reason: 'invalid', message: 'Durable skill review is available only in web or Lark runs.' };
    }
    if (
      input.member.runtimeThreadId !== input.execution.threadId
      || (input.member.runtimeRunId && input.member.runtimeRunId !== input.execution.runId)
    ) {
      return { ok: false, reason: 'permission_denied', message: 'Skill review provenance does not match the signed runtime.' };
    }
    if (channel === 'lark' && input.request.action !== 'delete') {
      const markdown = asString(asRecord(input.request.content)['markdown']) ?? '';
      const reviewError = assertLarkReviewableSkill(markdown);
      if (reviewError) return { ok: false, reason: 'invalid', message: reviewError };
    }

    const live = await this.runtimeFor(input.member, input.departmentId, input.execution);
    if (!live.ok) return live;
    const proposeArgs: Record<string, unknown> = {
      operation: 'propose',
      kind: 'skill',
      action: input.request.action,
      scope: input.request.scope,
      logicalKey: input.request.logicalKey,
      ...(input.request.baseVersion ? { baseVersion: input.request.baseVersion } : {}),
      ...(input.request.content !== undefined ? { content: input.request.content } : {}),
      ...(input.request.scope === 'department' && input.departmentId
        ? { departmentId: input.departmentId }
        : {}),
    };
    const proposed = await this.deps.tools.executeForRuntime({
      toolId: 'knowledge',
      args: proposeArgs,
      runContext: live.runContext,
      perm: live.permission,
      execution: input.execution,
      expectedAction: input.request.action === 'publish' ? 'create' : input.request.action,
    });
    if (proposed.status !== 'success') {
      return {
        ok: false,
        reason: proposed.status === 'permission_denied' ? 'permission_denied' : 'failed',
        message: proposed.message ?? 'The exact skill proposal could not be opened.',
      };
    }
    const proposal = asRecord(proposed.result);
    const mutationId = asString(proposal['mutationId']);
    const contentHash = proposal['contentHash'];
    if (!mutationId || (contentHash !== null && typeof contentHash !== 'string')) {
      return { ok: false, reason: 'failed', message: 'The backend did not return a durable skill mutation.' };
    }
    const mutation = await this.deps.mutations.get({
      mutationId,
      companyId: input.member.companyId,
    });
    const current = mutation.resourceId
      ? await this.deps.resources.get({
          companyId: mutation.companyId,
          userId: mutation.requesterId,
          resourceId: mutation.resourceId,
        })
      : null;
    if (
      (mutation.action === 'update' || mutation.action === 'delete')
      && (!current || current.kind !== 'skill')
    ) {
      await this.deps.mutations.cancel({
        mutationId: mutation.id,
        companyId: mutation.companyId,
        requesterId: mutation.requesterId,
      });
      return { ok: false, reason: 'invalid', message: 'The current skill is no longer readable.' };
    }
    const review = buildSkillChangeEvidence({
      action: mutation.action,
      ...(current?.kind === 'skill' ? { current: current.content } : {}),
      ...(mutation.proposedContent !== null ? { proposed: mutation.proposedContent } : {}),
      contentHash: mutation.proposedContentHash,
    });
    if (!review.ok) {
      await this.deps.mutations.cancel({
        mutationId: mutation.id,
        companyId: mutation.companyId,
        requesterId: mutation.requesterId,
      });
      return { ok: false, reason: 'invalid', message: review.message };
    }
    const skillEvidence = review.evidence;
    const args = applyArgs(mutation);
    const argsHash = computeArgsHash(args);
    const conversationKey = channel === 'web'
      ? input.execution.threadId
      : input.member.runtimeChatId ?? input.execution.threadId;
    let asked: Awaited<ReturnType<DecisionService['ask']>>;
    try {
      asked = await this.deps.decisions.ask({
      kind: 'tool_action',
      rowKind: KNOWLEDGE_SKILL_REVIEW_ROW_KIND,
      companyId: input.member.companyId,
      approver: {
        userId: input.member.userId,
        displayName: input.member.email ?? input.member.userId,
        larkOpenId: channel === 'lark' ? input.member.larkOpenId : null,
      },
      requestedBy: {
        userId: input.member.userId,
        displayName: input.member.email ?? input.member.userId,
      },
      summary: skillReviewTitle(mutation),
      toolId: 'knowledge',
      action: mutation.action === 'publish' ? 'create' : mutation.action,
      args,
      argsHash,
      metadata: {
        decisionKind: KNOWLEDGE_SKILL_REVIEW_ROW_KIND,
        mutationId: mutation.id,
        contentHash: mutation.proposedContentHash,
        approvalAuthority: mutation.requiredAuthority,
        requesterId: input.member.userId,
        requesterName: input.member.email ?? input.member.userId,
        requesterEmail: input.member.email,
        requesterLarkOpenId: input.member.larkOpenId,
        tenantKey: input.member.larkTenantKey ?? null,
        requesterAiRole: input.member.aiRole,
        sessionId: input.member.sessionId,
        sourceChannel: channel,
        sourceChatId: conversationKey,
        chatId: conversationKey,
        departmentId: input.departmentId ?? null,
        execution: input.execution,
        autoResume: false,
        approvalOrigin: 'knowledge_skill_review',
        requestId: input.request.requestId,
        decisionEvidence: skillEvidence,
      },
      channel,
      conversationKey,
      idempotencyKey: `knowledge-skill-review:${mutation.id}:${mutation.proposedContentHash ?? 'delete'}`,
      initialStatus: channel === 'lark' && input.member.larkOpenId ? 'dispatching' : 'pending',
      });
    } catch (error) {
      await this.deps.mutations.cancel({
        mutationId: mutation.id,
        companyId: mutation.companyId,
        requesterId: mutation.requesterId,
      }).catch(cancelError => this.log.error('knowledge_skill_review.open_cancel_failed', {
        mutationId: mutation.id,
        error: String(cancelError),
      }));
      return {
        ok: false,
        reason: 'failed',
        message: error instanceof Error ? error.message : 'The requester Decision could not be opened.',
      };
    }
    if (!asked.ok) {
      return { ok: false, reason: 'failed', message: asked.message };
    }
    if (!asked.created && asked.row.status === 'awaiting_governance') {
      if (mutation.runtimeApprovalId) {
        const authority = await this.deps.approvals.findById(mutation.runtimeApprovalId);
        const authorityRow = authority.ok ? authority.value : null;
        const authorityStatus = authorityRow?.status;
        if (authorityStatus === 'rejected' || authorityStatus === 'failed') {
          await this.settleLinkedOutcome({
            parentDecisionId: asked.row.id,
            approvalId: mutation.runtimeApprovalId,
            status: authorityStatus,
            result: authorityRow?.executionResultJson ?? { status: authorityStatus },
          });
          return this.open(input);
        }
        if (authorityStatus === 'consumed' && mutation.status === 'applied') {
          await this.settleLinkedOutcome({
            parentDecisionId: asked.row.id,
            approvalId: mutation.runtimeApprovalId,
            status: 'completed',
            result: authorityRow?.executionResultJson ?? { status: 'success' },
          });
          return {
            ok: true,
            mutationId: mutation.id,
            decisionId: asked.row.id,
            reused: true,
            state: 'applied',
            message: 'The reviewed skill change is already applied.',
          };
        }
      }
      return {
        ok: true,
        mutationId: mutation.id,
        decisionId: asked.row.id,
        reused: true,
        state: 'waiting_authority',
        message: 'The reviewed skill change is waiting for its authority decision.',
      };
    }
    if (!asked.created && asked.row.status === 'consumed' && mutation.status === 'applied') {
      const result = asRecord(asked.row.executionResultJson);
      const projection = asRecord(asRecord(result['data'])['result'])['projection'] ?? result['projection'];
      const state = projection === 'queued' ? 'projection_queued' as const : 'applied' as const;
      return {
        ok: true,
        mutationId: mutation.id,
        decisionId: asked.row.id,
        reused: true,
        state,
        message: state === 'projection_queued'
          ? 'The skill mutation is applied, but its runtime projection is still queued.'
          : 'The reviewed skill change is already applied.',
      };
    }
    if (!asked.created && asked.row.status === 'executing' && mutation.requesterReviewedAt) {
      const recovered = await this.continueApproved({
        row: asked.row,
        mutation,
        args,
        live: {
          runContext: live.runContext,
          permission: live.permission,
          execution: input.execution,
          chatId: conversationKey,
        },
        summary: 'Recovered the already-confirmed skill review.',
      });
      if (!recovered.ok) {
        return { ok: false, reason: 'failed', message: recovered.message };
      }
      const executionResult = asRecord(recovered.execution);
      const state = recovered.followUp === 'waiting'
        ? 'waiting_authority' as const
        : executionResult['projection'] === 'queued'
          ? 'projection_queued' as const
          : 'applied' as const;
      return {
        ok: true,
        mutationId: mutation.id,
        decisionId: asked.row.id,
        reused: true,
        state,
        message: asString(executionResult['message'])
          ?? (state === 'waiting_authority'
            ? 'The reviewed skill change is waiting for its authority decision.'
            : 'The reviewed skill change was recovered.'),
      };
    }
    this.log.info('knowledge_skill_review.opened', {
      mutationId: mutation.id,
      decisionId: asked.row.id,
      channel,
      reused: !asked.created,
    });
    return {
      ok: true,
      mutationId: mutation.id,
      decisionId: asked.row.id,
      reused: !asked.created,
      state: 'review_pending',
      message: 'The exact skill change is waiting for your review.',
    };
  }

  async decide(input: {
    readonly actor: DecisionActor;
    readonly row: RuntimeApprovalRow;
    readonly answer: DecisionAnswer;
    readonly verdict: 'approved' | 'rejected';
    readonly summary: string;
  }): Promise<SettleOutcome> {
    const args = asRecord(asRecord(input.row.payloadJson)['args']);
    const mutationId = asString(args['mutationId']);
    const contentHash = args['contentHash'];
    if (!mutationId || (contentHash !== null && typeof contentHash !== 'string')) {
      return { ok: false, reason: 'failed', message: 'This skill review is missing its durable mutation.' };
    }

    let settled;
    try {
      settled = await this.deps.mutations.settleRequesterDecision({
        mutationId,
        decisionId: input.row.id,
        companyId: input.actor.companyId,
        requesterId: input.actor.userId,
        expectedContentHash: contentHash ?? null,
        decision: input.verdict,
        summary: input.summary,
      });
    } catch (error) {
      return mutationFailure(error);
    }
    await this.deps.approvals.persistAnswer(input.row.id, input.answer);
    if (input.verdict === 'rejected') {
      const result = { status: 'cancelled', mutationId, message: 'Cancelled. The skill was not changed.' };
      await this.deps.approvals.persistResult(input.row.id, result);
      await this.recordOutcome(input.row, result.message);
      return {
        ok: true,
        verdict: 'rejected',
        decision: decisionFromRow(input.row),
        summary: input.summary,
        followUp: 'none',
        execution: result,
      };
    }

    const live = await this.runtimeForActor(input.actor, input.row);
    if (!live.ok) {
      await this.failRequesterDecision(input.row, settled.mutation, live.message);
      return { ok: false, reason: 'failed', message: live.message };
    }

    return this.continueApproved({
      row: input.row,
      mutation: settled.mutation,
      args,
      live,
      summary: input.summary,
    });
  }

  private async continueApproved(input: {
    readonly row: RuntimeApprovalRow;
    readonly mutation: KnowledgeMutationRecord;
    readonly args: Record<string, unknown>;
    readonly live: {
      readonly runContext: RunContext;
      readonly permission: PermissionResult;
      readonly execution: GatewayExecutionContext;
      readonly chatId: string;
    };
    readonly summary: string;
  }): Promise<SettleOutcome> {
    try {
      let mutation = input.mutation;
      if (mutation.status === 'applied') {
        const result = {
          status: 'applied',
          mutationId: mutation.id,
          projection: 'unknown',
          message: 'The canonical skill mutation is applied. Confirm its active projection before claiming the new revision is live.',
        };
        await this.deps.approvals.completeApprovedExecution(input.row.id, result);
        await this.recordOutcome(input.row, result.message);
        return settledOutcome(input.row, input.summary, result, 'none');
      }
      if (mutation.requiredAuthority === 'none') {
        const result = await this.applyAndProject(mutation);
        await this.deps.approvals.completeApprovedExecution(input.row.id, result);
        await this.recordOutcome(input.row, result.message);
        return settledOutcome(input.row, input.summary, result, 'none');
      }

      if (await this.requesterIsAuthority(mutation)) {
        await this.deps.mutations.attachRuntimeApproval({
          mutationId: mutation.id,
          companyId: mutation.companyId,
          requesterId: mutation.requesterId,
          expectedContentHash: mutation.proposedContentHash,
          approvalId: input.row.id,
          authority: mutation.requiredAuthority as 'department_manager',
        });
        mutation = await this.deps.mutations.acceptRuntimeApproval({
          mutationId: mutation.id,
          companyId: mutation.companyId,
          approvalId: input.row.id,
        });
        const result = await this.applyAndProject(mutation);
        await this.deps.approvals.completeApprovedExecution(input.row.id, result);
        await this.recordOutcome(input.row, result.message);
        return settledOutcome(input.row, input.summary, result, 'none');
      }

      const governed = await this.deps.tools.executeForRuntime({
        toolId: 'knowledge',
        args: input.args,
        runContext: input.live.runContext,
        perm: input.live.permission,
        execution: input.live.execution,
        approvalGate: this.deps.approvalGate,
        chatId: input.live.chatId,
        expectedAction: mutation.action === 'publish' ? 'create' : mutation.action,
        resumeOnApproval: true,
        parentDecisionId: input.row.id,
      });
      const result = runtimeResult(governed);
      if (governed.status === 'approval_required') {
        const marked = await this.deps.approvals.markAwaitingGovernance(input.row.id, result);
        if (!marked.ok || !marked.value) {
          throw new Error('Authority approval opened, but the requester Decision could not be linked safely.');
        }
        await this.recordOutcome(
          input.row,
          'Reviewed. The exact skill change is waiting for its authority decision.',
          'waiting',
        );
        return settledOutcome(input.row, input.summary, result, 'waiting');
      }
      if (governed.status === 'success') {
        await this.deps.approvals.completeApprovedExecution(input.row.id, result);
        await this.recordOutcome(
          input.row,
          asString(asRecord(governed.result)['message']) ?? 'The reviewed skill change completed.',
        );
        return settledOutcome(input.row, input.summary, result, 'none');
      }
      await this.failRequesterDecision(input.row, mutation, governed.message ?? 'Skill apply failed.');
      return settledOutcome(input.row, input.summary, result, 'none');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.failRequesterDecision(input.row, input.mutation, message);
      return { ok: false, reason: 'failed', message };
    }
  }

  async settleLinkedOutcome(input: LinkedDecisionOutcome): Promise<boolean> {
    const parent = await this.deps.approvals.findById(input.parentDecisionId);
    if (!parent.ok || !parent.value || parent.value.kind !== KNOWLEDGE_SKILL_REVIEW_ROW_KIND) return false;
    const args = asRecord(asRecord(parent.value.payloadJson)['args']);
    const mutationId = asString(args['mutationId']);
    if (!mutationId || !parent.value.companyId) return false;
    const settled = await this.deps.mutations.settleAuthorityDecision({
      mutationId,
      parentDecisionId: input.parentDecisionId,
      approvalId: input.approvalId,
      companyId: parent.value.companyId,
      status: input.status,
      result: input.result,
    });
    if (!settled.replayed) {
      await this.recordOutcome(
        parent.value,
        linkedOutcomeMessage(input.status, input.result),
      );
    }
    return true;
  }

  async reconcileLinkedOutcomes(limit = 100): Promise<void> {
    const expiredRequesterReviews = await this.deps.mutations.expireRequesterDecisions(limit);
    if (expiredRequesterReviews > 0) {
      this.log.info('knowledge_skill_review.requester_reviews_expired', {
        count: expiredRequesterReviews,
      });
    }
    const outcomes = await this.deps.approvals.listPendingLinkedSkillOutcomes(limit);
    for (const outcome of outcomes) {
      try {
        await this.settleLinkedOutcome(outcome);
      } catch (error) {
        this.log.error('knowledge_skill_review.reconcile_outcome_failed', {
          parentDecisionId: outcome.parentDecisionId,
          approvalId: outcome.approvalId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    await this.deps.outcomeDelivery?.deliverPending(limit);
  }

  private async runtimeFor(
    member: GatewayMemberContext,
    departmentId: string | undefined,
    execution: GatewayExecutionContext,
  ) {
    const channel = member.channel;
    if (channel !== 'web' && channel !== 'lark') {
      return { ok: false as const, reason: 'invalid' as const, message: 'Unsupported skill review channel.' };
    }
    const runContext = {
      companyId: asCompanyId(member.companyId),
      userId: asUserId(member.userId),
      companyRole: asCompanyRoleSlug(member.aiRole),
      channel,
      ...(departmentId ? { departmentId: asDepartmentId(departmentId) } : {}),
      ...(member.email ? { requesterEmail: member.email } : {}),
      requesterAiRole: member.aiRole,
      ...(member.larkOpenId ? { userExternalId: member.larkOpenId } : {}),
      ...(member.larkTenantKey ? { tenantId: member.larkTenantKey } : {}),
      chatId: member.runtimeChatId ?? execution.threadId,
      runtimeRunId: execution.runId,
      runtimeThreadId: execution.threadId,
      traceId: execution.runId,
    } as const;
    const permission = await this.deps.permissions.resolve({
      companyId: runContext.companyId,
      userId: runContext.userId,
      companyRole: runContext.companyRole,
      channel,
      ...(runContext.departmentId ? { departmentId: runContext.departmentId } : {}),
    });
    if (!permission.ok) {
      return { ok: false as const, reason: 'permission_denied' as const, message: permission.error.message };
    }
    return { ok: true as const, runContext, permission: permission.value };
  }

  private async runtimeForActor(actor: DecisionActor, row: RuntimeApprovalRow) {
    const metadata = asRecord(row.metadataJson);
    const execution = readExecution(metadata['execution']);
    if (!execution) return { ok: false as const, message: 'Skill review lost its runtime provenance.' };
    if (actor.member) {
      const live = await this.runtimeFor(
        actor.member,
        asString(metadata['departmentId']),
        execution,
      );
      return live.ok
        ? { ...live, execution, chatId: asString(metadata['sourceChatId']) ?? execution.threadId }
        : { ok: false as const, message: live.message };
    }
    if (!actor.lark || !this.deps.identities) {
      return { ok: false as const, message: 'A current authenticated identity is required to apply this skill.' };
    }
    const identity = await this.deps.identities.resolveByLarkTenantIdentity(actor.lark.openId, actor.lark.tenantKey);
    if (!identity.ok || !identity.value || identity.value.userId !== actor.userId || identity.value.companyId !== actor.companyId) {
      return { ok: false as const, message: 'Divo could not recheck the requester identity.' };
    }
    const member: GatewayMemberContext = {
      companyId: identity.value.companyId,
      userId: identity.value.userId,
      aiRole: identity.value.aiRole,
      channel: 'lark',
      email: identity.value.email ?? null,
      larkOpenId: actor.lark.openId,
      larkTenantKey: actor.lark.tenantKey,
      ...(asString(metadata['sourceChatId'])
        ? { runtimeChatId: asString(metadata['sourceChatId'])! }
        : {}),
      runtimeRunId: execution.runId,
      runtimeThreadId: execution.threadId,
      sessionId: `decision:${row.id}`,
    };
    const live = await this.runtimeFor(member, asString(metadata['departmentId']), execution);
    return live.ok
      ? { ...live, execution, chatId: asString(metadata['sourceChatId']) ?? execution.threadId }
      : { ok: false as const, message: live.message };
  }

  private async requesterIsAuthority(mutation: KnowledgeMutationRecord): Promise<boolean> {
    if (
      mutation.requiredAuthority !== 'department_manager'
      || mutation.distinctApprover
      || !mutation.departmentId
    ) return false;
    const manager = await this.deps.approvalResolver.resolveManager(
      mutation.departmentId,
      mutation.companyId,
      { allowCompanyAdminFallback: false },
    );
    return manager?.userId === mutation.requesterId;
  }

  private async applyAndProject(mutation: KnowledgeMutationRecord) {
    const applied = await this.deps.mutations.apply({
      mutationId: mutation.id,
      companyId: mutation.companyId,
    });
    const skillName = asString(asRecord(mutation.proposedContent)['name']) ?? mutation.logicalKey;
    const appliedVerb = mutation.action === 'create' || mutation.action === 'publish'
      ? 'Added'
      : 'Updated';
    let projection: 'completed' | 'queued' = 'completed';
    try {
      await this.deps.projections.projectMutation(mutation.id);
    } catch (error) {
      projection = 'queued';
      this.log.error('knowledge_skill_review.projection_queued', {
        mutationId: mutation.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return {
      status: projection === 'completed' ? 'applied' : 'projection_queued',
      mutationId: mutation.id,
      resourceId: applied.resourceId,
      version: applied.version,
      projection,
      message: projection === 'completed'
        ? mutation.action === 'delete'
          ? `Removed ${skillName}. Divo will stop loading it from the next turn.`
          : `${appliedVerb} ${skillName} at revision ${applied.version}. Divo will use it from the next turn.`
        : `Committed ${skillName} as revision ${applied.version}, but its runtime update is still queued.`,
    };
  }

  private async failRequesterDecision(
    row: RuntimeApprovalRow,
    mutation: KnowledgeMutationRecord,
    message: string,
  ): Promise<void> {
    await this.deps.approvals.failApprovedExecution(row.id, { status: 'failed', message });
    await this.recordOutcome(row, `The reviewed skill change could not be completed: ${message}`);
    if (['awaiting_requester_review', 'awaiting_approval', 'approved'].includes(mutation.status)) {
      await this.deps.mutations.cancel({
        mutationId: mutation.id,
        companyId: mutation.companyId,
        requesterId: mutation.requesterId,
      }).catch(error => this.log.error('knowledge_skill_review.cancel_failed', {
        mutationId: mutation.id,
        error: String(error),
      }));
    }
  }

  private async recordOutcome(
    row: RuntimeApprovalRow,
    content: string,
    phase: 'waiting' | 'terminal' = 'terminal',
  ): Promise<void> {
    const metadata = asRecord(row.metadataJson);
    if (metadata['sourceChannel'] === 'lark') {
      if (phase === 'waiting') return;
      if (!this.deps.outcomeDelivery) {
        this.log.error('knowledge_skill_review.lark_outcome_unavailable', {
          decisionId: row.id,
        });
        return;
      }
      try {
        await this.deps.outcomeDelivery.deliver(row.id);
      } catch (error) {
        this.log.error('knowledge_skill_review.lark_outcome_failed', {
          decisionId: row.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    if (metadata['sourceChannel'] !== 'web' || !this.deps.transcript) return;
    const threadId = readExecution(metadata['execution'])?.threadId;
    if (!threadId) return;
    await this.deps.transcript.appendTurn(
      threadId,
      { role: 'assistant', content, timestamp: new Date().toISOString() },
      { companyId: row.companyId!, channel: 'web' },
      { dedupeKey: `knowledge_skill_review:${row.id}:${phase}` },
    ).catch(error => this.log.error('knowledge_skill_review.outcome_write_failed', {
      decisionId: row.id,
      error: String(error),
    }));
  }
}

function linkedOutcomeMessage(
  status: LinkedDecisionOutcome['status'],
  result: unknown,
): string {
  const exact = asString(asRecord(result)['message'])
    ?? asString(asRecord(asRecord(result)['result'])['message'])
    ?? asString(asRecord(asRecord(result)['data'])['message'])
    ?? asString(asRecord(asRecord(asRecord(result)['data'])['result'])['message']);
  if (status === 'completed') return exact ?? 'The reviewed skill change was applied.';
  if (status === 'rejected') return 'The required authority rejected the reviewed skill change. Nothing was changed.';
  return exact
    ? `The reviewed skill change could not be completed: ${exact}`
    : 'The reviewed skill change could not be completed because its authority step failed.';
}

function applyArgs(mutation: KnowledgeMutationRecord): Record<string, unknown> {
  return {
    operation: 'apply',
    mutationId: mutation.id,
    contentHash: mutation.proposedContentHash,
    kind: 'skill',
    action: mutation.action,
    scope: mutation.scope,
    ...(mutation.proposedContent !== null ? { content: mutation.proposedContent } : {}),
    ...(mutation.departmentId ? { departmentId: mutation.departmentId } : {}),
  };
}

function skillReviewTitle(mutation: KnowledgeMutationRecord): string {
  const scope = mutation.scope === 'department' ? 'department' : mutation.scope;
  if (mutation.action === 'delete') return `Remove ${mutation.logicalKey} from ${scope} skills`;
  const content = asRecord(mutation.proposedContent);
  return `Review ${scope} skill: ${asString(content['name']) ?? mutation.logicalKey}`;
}

function runtimeResult(outcome: Awaited<ReturnType<ToolExecutor['executeForRuntime']>>) {
  return {
    status: outcome.status,
    toolId: outcome.toolId,
    ...(outcome.action ? { action: outcome.action } : {}),
    ...(outcome.result !== undefined ? { result: outcome.result } : {}),
    ...(outcome.message ? { message: outcome.message } : {}),
    ...(outcome.approvalId ? { approvalId: outcome.approvalId } : {}),
  };
}

function settledOutcome(
  row: RuntimeApprovalRow,
  summary: string,
  execution: unknown,
  followUp: 'none' | 'waiting',
): SettleOutcome {
  return {
    ok: true,
    verdict: 'approved',
    decision: decisionFromRow(row),
    summary,
    followUp,
    execution,
  };
}

function mutationFailure(error: unknown): Extract<SettleOutcome, { ok: false }> {
  if (error instanceof KnowledgeMutationError) {
    return {
      ok: false,
      reason: error.code === 'permission_denied' ? 'forbidden' : 'failed',
      message: error.message,
    };
  }
  return { ok: false, reason: 'failed', message: error instanceof Error ? error.message : String(error) };
}

function decisionFromRow(row: RuntimeApprovalRow) {
  const metadata = asRecord(row.metadataJson);
  return {
    id: row.id,
    title: row.summary,
    source: asString(metadata['requesterName']) ?? 'Divo',
    questions: [],
    requestedAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    threadId: readExecution(metadata['execution'])?.threadId ?? null,
  };
}

function readExecution(value: unknown): GatewayExecutionContext | undefined {
  const record = asRecord(value);
  return record['version'] === 1
    && typeof record['threadId'] === 'string'
    && typeof record['runId'] === 'string'
    && typeof record['actionId'] === 'string'
    ? record as unknown as GatewayExecutionContext
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
