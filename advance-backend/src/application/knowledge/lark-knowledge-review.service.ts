import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CachePort } from '../../shared/cache';
import type { LarkChannelAdapter } from '../../infrastructure/channels/lark/lark.adapter';
import type { Logger } from '../../shared/logger';
import type { ToolExecutor } from '../gateway/tool-executor';
import type { PermissionService } from '../permissions/permission.service';
import type { PermissionResult } from '../permissions/permission.types';
import type { ApprovalGateService } from '../approval/approval-gate.service';
import type { RunContext } from '../../domain/orchestration/run-context';
import { asCompanyId, asDepartmentId, asUserId } from '../../shared/ids';
import { asCompanyRoleSlug } from '../../domain/permissions/company-role';
import type { KnowledgeReviewDecisionQueuePort } from './knowledge-review-decision.queue';
import type { ChannelIdentityRepoPort } from '../../infrastructure/persistence/channel-identity.repository';
import type { KnowledgeMutationService } from './knowledge-mutation.service';
import {
  assertLarkReviewableSkill,
  exactSkillReviewBlocks,
} from './knowledge-review-presentation';

/**
 * One Lark review surface for every shared knowledge mutation. The card only
 * records the requester's exact-content confirmation; the knowledge mutation
 * service and approval gate remain the authority for policy and publication.
 */

const KNOWLEDGE_REVIEW_CACHE_PREFIX = 'lark:knowledge-review:v1:';
const KNOWLEDGE_REVIEW_TTL_SECONDS = 24 * 60 * 60;

const MemoryReviewInputSchema = z.object({
  proposalId: z.string().min(1).max(120),
  bullets: z.array(z.string().trim().min(1).max(500)).min(1).max(10),
}).strict();

interface KnowledgeReviewTarget {
  scope: 'personal' | 'department' | 'company';
  label: string;
  departmentId?: string;
}

interface KnowledgeReviewRequest {
  reviewId: string;
  proposalId: string;
  requesterUserId: string;
  requesterOpenId: string;
  companyId: string;
  chatId: string;
  facts: string[];
  kind: 'memory' | 'skill' | 'file';
  action: 'create' | 'update' | 'publish' | 'delete';
  logicalKey: string;
  baseVersion?: number;
  content: unknown | null;
  targets: KnowledgeReviewTarget[];
  ready: boolean;
  cardMessageId?: string;
}

interface KnowledgeReviewQueuedDecision {
  action: 'knowledge_review_publish' | 'knowledge_review_cancel';
  targetKey: string;
  actor: AuthenticatedCardActor;
}

/** Who pressed the button on a Lark card, as resolved from the callback. */
export interface AuthenticatedCardActor {
  userId: string;
  companyId: string;
  aiRole: string;
  openId: string;
  tenantKey?: string;
  displayName?: string;
  activeDepartmentId?: string;
}

export interface CardCallbackResult {
  ok: boolean;
  responseBody: Record<string, unknown>;
}

export const KNOWLEDGE_REVIEW_OPENED_MESSAGE =
  'The exact facts are waiting in a Lark review card. Nothing is saved until you approve one target.';

export interface OpenMemoryReviewInput {
  proposalId: string;
  facts: string[];
  runContext: RunContext;
  perm: PermissionResult;
  chatId: string;
  requestedScope?: 'department' | 'company';
  onOpened?: (receipt: {
    reviewId: string;
    cardMessageId: string;
    message: string;
  }) => Promise<void>;
}

export interface OpenKnowledgeReviewResult {
  opened: boolean;
  message: string;
  reviewId?: string;
  cardMessageId?: string;
}

export interface OpenResourceReviewInput {
  requestId: string;
  kind: 'skill' | 'file';
  action: 'create' | 'update' | 'publish' | 'delete';
  scope: 'personal' | 'department' | 'company';
  logicalKey: string;
  baseVersion?: number;
  content?: unknown;
  runContext: RunContext;
  perm: PermissionResult;
  chatId: string;
  onOpened?: OpenMemoryReviewInput['onOpened'];
}

export class LarkKnowledgeReviewService {
  private readonly log: Logger;

  constructor(
    private readonly cache: CachePort,
    private readonly larkAdapter: LarkChannelAdapter,
    private readonly toolExecutor: ToolExecutor,
    private readonly permissions: PermissionService,
    private readonly approvalGate: ApprovalGateService,
    private readonly knowledgeMutations: KnowledgeMutationService,
    logger: Logger,
    private readonly decisionQueue?: KnowledgeReviewDecisionQueuePort,
    private readonly cardCallbacksConfigured = true,
    private readonly identityRepo?: Pick<ChannelIdentityRepoPort, 'resolveByLarkTenantIdentity'>,
  ) {
    this.log = logger.child({ service: 'lark-knowledge-review' });
  }

  async openMemoryForRuntime(
    input: OpenMemoryReviewInput,
  ): Promise<OpenKnowledgeReviewResult> {
    if (!this.cardCallbacksConfigured) {
      return {
        opened: false,
        message: 'Memory review is unavailable because the Lark card callback is not configured for this backend.',
      };
    }
    if (!input.runContext.userExternalId) {
      return {
        opened: false,
        message: 'Memory review is unavailable because the requester identity is missing.',
      };
    }
    const parsed = MemoryReviewInputSchema.safeParse({
      proposalId: input.proposalId,
      bullets: input.facts,
    });
    if (!parsed.success) {
      return {
        opened: false,
        message: 'Memory review was not opened because the proposed facts are invalid.',
      };
    }
    const authority = await this.checkAuthority(input.runContext, input.perm);
    if (!authority.ok) return { opened: false, message: authority.message };
    const targets = requestedMemoryTargets(
      authority.targets,
      input.requestedScope,
      input.runContext.departmentId ? String(input.runContext.departmentId) : undefined,
    );
    if (targets.length === 0) {
      return {
        opened: false,
        message: `You do not have an available ${input.requestedScope ?? 'shared'} memory target.`,
      };
    }

    const reviewId = randomUUID();
    const request: KnowledgeReviewRequest = {
      reviewId,
      proposalId: parsed.data.proposalId,
      requesterUserId: String(input.runContext.userId),
      requesterOpenId: input.runContext.userExternalId,
      companyId: String(input.runContext.companyId),
      chatId: input.chatId,
      facts: parsed.data.bullets,
      kind: 'memory',
      action: 'publish',
      logicalKey: parsed.data.proposalId,
      content: { facts: parsed.data.bullets },
      targets,
      ready: false,
    };
    return this.openReviewRequest(request, input.onOpened);
  }

  async openResourceForRuntime(
    input: OpenResourceReviewInput,
  ): Promise<OpenKnowledgeReviewResult> {
    if (!this.cardCallbacksConfigured) {
      return { opened: false, message: 'Knowledge review is unavailable because Lark card callbacks are not configured.' };
    }
    if (!input.runContext.userExternalId) {
      return { opened: false, message: 'Knowledge review is unavailable because the requester identity is missing.' };
    }
    if (!input.requestId.trim() || !input.logicalKey.trim()) {
      return { opened: false, message: 'Knowledge review request is invalid.' };
    }
    if (input.action === 'delete' ? input.content !== undefined : input.content === undefined) {
      return { opened: false, message: 'Knowledge review content does not match its action.' };
    }
    if (input.kind === 'skill' && input.action !== 'delete') {
      const content = asRecord(input.content);
      const markdown = typeof content['markdown'] === 'string' ? content['markdown'] : '';
      const reviewError = assertLarkReviewableSkill(markdown);
      if (reviewError) return { opened: false, message: reviewError };
    }
    const authority = await this.checkAuthority(input.runContext, input.perm);
    if (!authority.ok) return { opened: false, message: authority.message };
    const targets = authority.targets.filter(target => target.scope === input.scope);
    if (targets.length === 0) {
      return { opened: false, message: `You do not have an available ${input.scope} knowledge target.` };
    }
    const request: KnowledgeReviewRequest = {
      reviewId: randomUUID(),
      proposalId: input.requestId,
      requesterUserId: String(input.runContext.userId),
      requesterOpenId: input.runContext.userExternalId,
      companyId: String(input.runContext.companyId),
      chatId: input.chatId,
      facts: [],
      kind: input.kind,
      action: input.action,
      logicalKey: input.logicalKey,
      ...(input.baseVersion ? { baseVersion: input.baseVersion } : {}),
      content: input.content ?? null,
      targets,
      ready: false,
    };
    return this.openReviewRequest(request, input.onOpened);
  }

  private async openReviewRequest(
    request: KnowledgeReviewRequest,
    onOpened?: OpenMemoryReviewInput['onOpened'],
  ): Promise<OpenKnowledgeReviewResult> {
    const reviewId = request.reviewId;
    const openedMessage = openedReviewMessage(request);
    const noun = reviewNoun(request);
    const stored = await this.cache.set(
      knowledgeReviewKey(reviewId),
      request,
      KNOWLEDGE_REVIEW_TTL_SECONDS,
    );
    if (!stored.ok) {
      this.log.error('knowledge_review.cache_write_failed', { reviewId });
      return { opened: false, message: `${titleCase(noun)} review could not be opened. Please try again.` };
    }

    const sent = await this.larkAdapter.sendCardToChat(
      request.chatId,
      buildKnowledgeReviewCard(request),
    );
    if (!sent.ok) {
      await this.cache.del(knowledgeReviewKey(reviewId));
      const upstream = sent.error.payload.cause;
      const upstreamRecord = upstream && typeof upstream === 'object'
        ? upstream as Record<string, unknown>
        : undefined;
      this.log.warn('knowledge_review.card_send_failed', {
        reviewId,
        error: sent.error.message,
        upstreamError: upstream instanceof Error
          ? upstream.message.slice(0, 1_000)
          : undefined,
        upstreamStatus: typeof upstreamRecord?.['status'] === 'number'
          ? upstreamRecord['status']
          : undefined,
        upstreamCode: typeof upstreamRecord?.['code'] === 'number'
          ? upstreamRecord['code']
          : undefined,
      });
      return { opened: false, message: `${titleCase(noun)} review could not be delivered. Please try again.` };
    }
    const readyRequest: KnowledgeReviewRequest = {
      ...request,
      cardMessageId: sent.value.messageId,
      ready: true,
    };
    const cardStateStored = await this.cache.set(
      knowledgeReviewKey(reviewId),
      readyRequest,
      KNOWLEDGE_REVIEW_TTL_SECONDS,
    );
    if (!cardStateStored.ok) {
      await this.cache.setNx(
        knowledgeReviewLockKey(reviewId),
        'card_state_failed',
        KNOWLEDGE_REVIEW_TTL_SECONDS,
      );
      await this.cache.del(knowledgeReviewKey(reviewId));
      await this.larkAdapter.updateMessageById(
        sent.value.messageId,
        buildKnowledgeReviewResolvedCard('failed', readyRequest),
      );
      this.log.error('knowledge_review.card_state_write_failed', { reviewId });
      return {
        opened: false,
        message: `${titleCase(noun)} review could not be opened safely. Nothing was saved.`,
      };
    }
    try {
      await onOpened?.({
        reviewId,
        cardMessageId: sent.value.messageId,
        message: openedMessage,
      });
    } catch (error) {
      await this.cache.setNx(
        knowledgeReviewLockKey(reviewId),
        'receipt_failed',
        KNOWLEDGE_REVIEW_TTL_SECONDS,
      );
      await this.cache.del(knowledgeReviewKey(reviewId));
      await this.larkAdapter.updateMessageById(
        sent.value.messageId,
        buildKnowledgeReviewResolvedCard('failed', readyRequest),
      );
      this.log.error('knowledge_review.receipt_write_failed', {
        reviewId,
        error: String(error),
      });
      return {
        opened: false,
        message: `${titleCase(noun)} review could not be verified safely. Nothing was saved.`,
      };
    }
    this.log.info('knowledge_review.opened', {
      reviewId,
      requesterUserId: request.requesterUserId,
      targetCount: request.targets.length,
      factCount: request.facts.length,
      kind: request.kind,
      action: request.action,
    });
    return {
      opened: true,
      message: openedMessage,
      reviewId,
      cardMessageId: sent.value.messageId,
    };
  }

  isKnowledgeReviewAction(cardEvent: unknown): boolean {
    const { action } = parseKnowledgeReviewAction(cardEvent);
    return action === 'knowledge_review_publish' || action === 'knowledge_review_cancel';
  }

  async handle(
    cardEvent: unknown,
    actor: AuthenticatedCardActor,
  ): Promise<CardCallbackResult> {
    const parsed = parseKnowledgeReviewAction(cardEvent);
    if (!parsed.reviewId) return knowledgeReviewToast(false, 'This knowledge review is invalid.');

    const cached = await this.cache.get<KnowledgeReviewRequest>(knowledgeReviewKey(parsed.reviewId));
    if (!cached.ok || !cached.value) {
      return knowledgeReviewToast(false, 'This knowledge review expired or was already resolved.');
    }
    const request = cached.value;
    if (!request.ready) {
      return knowledgeReviewToast(false, 'This knowledge review was not opened safely.');
    }
    if (
      actor.companyId !== request.companyId
      || actor.userId !== request.requesterUserId
      || actor.openId !== request.requesterOpenId
    ) {
      this.log.warn('knowledge_review.unauthorized_actor', {
        reviewId: request.reviewId,
        actorUserId: actor.userId,
        requesterUserId: request.requesterUserId,
      });
      return knowledgeReviewToast(false, 'Only the person who opened this review can decide it.');
    }

    const selected = parsed.action === 'knowledge_review_publish'
      ? request.targets.find(target => reviewTargetKey(target) === parsed.targetKey)
      : undefined;
    if (parsed.action === 'knowledge_review_publish' && !selected) {
      return knowledgeReviewToast(false, 'That target is not part of this review.');
    }

    if (this.decisionQueue) {
      const decision: KnowledgeReviewQueuedDecision = {
        action: parsed.action as KnowledgeReviewQueuedDecision['action'],
        targetKey: parsed.targetKey,
        actor: {
          userId: actor.userId,
          companyId: actor.companyId,
          aiRole: actor.aiRole,
          openId: actor.openId,
          ...(actor.tenantKey ? { tenantKey: actor.tenantKey } : {}),
          ...(actor.displayName ? { displayName: actor.displayName } : {}),
          ...(actor.activeDepartmentId
            ? { activeDepartmentId: actor.activeDepartmentId }
            : {}),
        },
      };
      const reserved = await this.cache.setNx(
        knowledgeReviewDecisionKey(request.reviewId),
        decision,
        KNOWLEDGE_REVIEW_TTL_SECONDS,
      );
      if (!reserved.ok) {
        return knowledgeReviewToast(false, 'Divo could not safely queue this decision. Please try again.');
      }
      try {
        await this.decisionQueue.enqueue(request.reviewId);
      } catch (error) {
        if (reserved.value) {
          await this.cache.del(knowledgeReviewDecisionKey(request.reviewId));
        }
        this.log.error('knowledge_review.queue_failed', {
          reviewId: request.reviewId,
          error: String(error),
        });
        return knowledgeReviewToast(false, 'Divo could not queue this decision. Please try again.');
      }
      this.log.info('knowledge_review.queued', {
        reviewId: request.reviewId,
        action: decision.action,
        reused: !reserved.value,
      });
      return knowledgeReviewImmediateCard(buildKnowledgeReviewProcessingCard(request));
    }

    const lock = await this.cache.setNx(
      knowledgeReviewLockKey(request.reviewId),
      actor.userId,
      KNOWLEDGE_REVIEW_TTL_SECONDS,
    );
    if (!lock.ok || !lock.value) {
      return knowledgeReviewToast(false, 'This knowledge review is already being processed.');
    }
    const claimed = await this.cache.del(knowledgeReviewKey(request.reviewId));
    if (!claimed.ok) {
      await this.finishRequest(request, buildKnowledgeReviewResolvedCard('failed', request));
      return knowledgeReviewToast(false, 'Divo could not claim this review safely. Nothing was saved.');
    }

    return this.executeDecision(request, {
      action: parsed.action as KnowledgeReviewQueuedDecision['action'],
      targetKey: parsed.targetKey,
    }, actor);
  }

  /**
   * Runs in the durable BullMQ worker. The callback stores an authenticated,
   * idempotent decision and returns to Lark immediately.
   */
  async processQueuedDecision(reviewId: string): Promise<void> {
    const [requestResult, decisionResult] = await Promise.all([
      this.cache.get<KnowledgeReviewRequest>(knowledgeReviewKey(reviewId)),
      this.cache.get<KnowledgeReviewQueuedDecision>(knowledgeReviewDecisionKey(reviewId)),
    ]);
    if (!requestResult.ok) throw requestResult.error;
    if (!decisionResult.ok) throw decisionResult.error;
    if (!requestResult.value || !decisionResult.value) {
      this.log.info('knowledge_review.worker.already_terminal', { reviewId });
      return;
    }
    const request = requestResult.value;
    const decision = decisionResult.value;
    if (!request.ready) {
      await this.finishRequest(request, buildKnowledgeReviewResolvedCard('failed', request));
      const removed = await this.cache.del(knowledgeReviewKey(reviewId));
      if (!removed.ok) throw removed.error;
      return;
    }

    const actor = await this.resolveQueuedActor(decision.actor);
    if (!actor) {
      await this.finishRequest(request, buildKnowledgeReviewResolvedCard('denied', request));
      const removed = await this.cache.del(knowledgeReviewKey(reviewId));
      if (!removed.ok) throw removed.error;
      return;
    }

    await this.executeDecision(request, decision, actor);
    const removed = await this.cache.del(knowledgeReviewKey(reviewId));
    if (!removed.ok) throw removed.error;
  }

  private async executeDecision(
    request: KnowledgeReviewRequest,
    decision: Pick<KnowledgeReviewQueuedDecision, 'action' | 'targetKey'>,
    actor: AuthenticatedCardActor,
  ): Promise<CardCallbackResult> {
    if (decision.action === 'knowledge_review_cancel') {
      await this.finishRequest(request, buildKnowledgeReviewResolvedCard('cancelled', request));
      return knowledgeReviewToast(true, cancelledReviewMessage(request));
    }

    const live = await this.resolveLiveAuthority(actor, request.chatId);
    if (!live.ok) {
      await this.finishRequest(request, buildKnowledgeReviewResolvedCard('failed', request));
      return knowledgeReviewToast(false, `${live.message} Nothing was saved; open a new review to retry.`);
    }
    const liveTarget = live.targets.find(target => reviewTargetKey(target) === decision.targetKey);
    if (!liveTarget) {
      await this.finishRequest(request, buildKnowledgeReviewResolvedCard('denied', request));
      return knowledgeReviewToast(false, 'Your access changed. This target is no longer available.');
    }

    const proposed = await this.toolExecutor.executeForRuntime({
      toolId: 'knowledge',
      args: {
        operation: 'propose',
        kind: request.kind,
        action: request.action,
        scope: liveTarget.scope,
        logicalKey: request.logicalKey,
        ...(request.baseVersion ? { baseVersion: request.baseVersion } : {}),
        ...(request.content !== null ? { content: request.content } : {}),
        ...(liveTarget.departmentId ? { departmentId: liveTarget.departmentId } : {}),
      },
      runContext: live.runContext,
      perm: live.perm,
      expectedAction: request.action === 'publish' ? 'create' : request.action,
    });
    if (proposed.status !== 'success') {
      await this.finishRequest(request, buildKnowledgeReviewResolvedCard('failed', request));
      return knowledgeReviewToast(false, proposed.message ?? 'Knowledge proposal could not be saved safely.');
    }
    const proposalResult = proposed.result as Record<string, unknown> | undefined;
    const mutationId = proposalResult?.['mutationId'];
    const contentHash = proposalResult?.['contentHash'];
    if (typeof mutationId !== 'string' || (contentHash !== null && typeof contentHash !== 'string')) {
      await this.finishRequest(request, buildKnowledgeReviewResolvedCard('failed', request));
      return knowledgeReviewToast(false, 'Knowledge proposal did not return a durable review receipt.');
    }
    try {
      await this.knowledgeMutations.confirmRequesterReview({
        mutationId,
        companyId: request.companyId,
        requesterId: request.requesterUserId,
        expectedContentHash: contentHash ?? null,
      });
    } catch (error) {
      await this.finishRequest(request, buildKnowledgeReviewResolvedCard('failed', request));
      this.log.warn('knowledge_review.confirm_failed', {
        reviewId: request.reviewId,
        error: error instanceof Error ? error.message : String(error),
      });
      return knowledgeReviewToast(false, 'The exact reviewed content could not be confirmed.');
    }

    const args: Record<string, unknown> = {
      operation: 'apply',
      mutationId,
      contentHash: contentHash ?? null,
      kind: request.kind,
      action: request.action,
      scope: liveTarget.scope,
      ...(request.content !== null ? { content: request.content } : {}),
      ...(liveTarget.departmentId ? { departmentId: liveTarget.departmentId } : {}),
    };
    const outcome = await this.toolExecutor.executeForRuntime({
      toolId: 'knowledge',
      args,
      runContext: live.runContext,
      perm: live.perm,
      approvalGate: this.approvalGate,
      chatId: request.chatId,
      expectedAction: request.action === 'publish' ? 'create' : request.action,
    });

    if (outcome.status === 'success') {
      await this.finishRequest(request, buildKnowledgeReviewResolvedCard('saved', request, liveTarget));
      return knowledgeReviewToast(true, successfulReviewMessage(request, liveTarget.label));
    }
    if (outcome.status === 'approval_required') {
      await this.finishRequest(request, buildKnowledgeReviewResolvedCard('pending', request, liveTarget));
      return knowledgeReviewToast(
        true,
        `Reviewed. The exact request is waiting for ${liveTarget.scope === 'company' ? 'company administrator' : 'department manager'} approval.`,
      );
    }

    await this.finishRequest(request, buildKnowledgeReviewResolvedCard('failed', request));
    this.log.warn('knowledge_review.publish_failed', {
      reviewId: request.reviewId,
      status: outcome.status,
    });
    return knowledgeReviewToast(false, outcome.message ?? `${titleCase(reviewNoun(request))} could not be changed.`);
  }

  private async checkAuthority(
    runContext: RunContext,
    perm: PermissionResult,
  ): Promise<{ ok: true; targets: KnowledgeReviewTarget[] } | { ok: false; message: string }> {
    const outcome = await this.toolExecutor.executeForRuntime({
      toolId: 'knowledge',
      args: { operation: 'check_targets' },
      runContext,
      perm,
      expectedAction: 'read',
    });
    if (outcome.status !== 'success') {
      return { ok: false, message: outcome.message ?? 'Shared knowledge is unavailable.' };
    }
    const result = outcome.result as Record<string, unknown> | undefined;
    const targets = parseKnowledgeTargets(result?.['targets']);
    return targets.length > 0
      ? { ok: true, targets }
      : { ok: false, message: 'You do not have an available shared knowledge target.' };
  }

  private async resolveLiveAuthority(
    actor: AuthenticatedCardActor,
    chatId: string,
  ): Promise<
    | { ok: true; runContext: RunContext; perm: PermissionResult; targets: KnowledgeReviewTarget[] }
    | { ok: false; message: string }
  > {
    const live = await this.resolveLivePermission(actor, chatId);
    if (!live.ok) return live;
    const authority = await this.checkAuthority(live.runContext, live.perm);
    return authority.ok
      ? { ...live, targets: authority.targets }
      : authority;
  }

  private async resolveLivePermission(
    actor: AuthenticatedCardActor,
    chatId: string,
  ): Promise<
    | { ok: true; runContext: RunContext; perm: PermissionResult }
    | { ok: false; message: string }
  > {
    const runContext: RunContext = {
      companyId: asCompanyId(actor.companyId),
      userId: asUserId(actor.userId),
      companyRole: asCompanyRoleSlug(actor.aiRole),
      channel: 'lark',
      ...(actor.tenantKey ? { tenantId: actor.tenantKey } : {}),
      userExternalId: actor.openId,
      chatId,
      ...(actor.activeDepartmentId
        ? { departmentId: asDepartmentId(actor.activeDepartmentId) }
        : {}),
    };
    const resolved = await this.permissions.resolve({
      companyId: runContext.companyId,
      userId: runContext.userId,
      companyRole: runContext.companyRole,
      channel: 'lark',
      ...(runContext.departmentId ? { departmentId: runContext.departmentId } : {}),
    });
    if (!resolved.ok) {
      return { ok: false, message: 'Divo could not recheck your current access.' };
    }
    return { ok: true, runContext, perm: resolved.value };
  }

  private async resolveQueuedActor(
    snapshot: AuthenticatedCardActor,
  ): Promise<AuthenticatedCardActor | null> {
    if (!this.identityRepo) return snapshot;
    if (!snapshot.tenantKey) return null;

    const resolved = await this.identityRepo.resolveByLarkTenantIdentity(
      snapshot.openId,
      snapshot.tenantKey,
    );
    if (!resolved.ok) throw resolved.error;
    const live = resolved.value;
    if (
      !live
      || live.userId !== snapshot.userId
      || live.companyId !== snapshot.companyId
    ) {
      return null;
    }
    return {
      userId: live.userId,
      companyId: live.companyId,
      aiRole: live.aiRole,
      openId: snapshot.openId,
      tenantKey: snapshot.tenantKey,
      ...(live.displayName ? { displayName: live.displayName } : {}),
      ...(live.activeDepartmentId
        ? { activeDepartmentId: live.activeDepartmentId }
        : {}),
    };
  }

  private async finishRequest(request: KnowledgeReviewRequest, card: string): Promise<void> {
    if (request.cardMessageId) {
      const updated = await this.larkAdapter.updateMessageById(request.cardMessageId, card);
      if (!updated.ok) {
        this.log.warn('knowledge_review.card_update_failed', {
          reviewId: request.reviewId,
          error: updated.error.message,
        });
      }
    }
  }
}

function requestedMemoryTargets(
  targets: readonly KnowledgeReviewTarget[],
  requestedScope: OpenMemoryReviewInput['requestedScope'],
  activeDepartmentId: string | undefined,
): KnowledgeReviewTarget[] {
  if (!requestedScope) return [...targets];
  if (requestedScope === 'company') {
    return targets.filter(target => target.scope === 'company');
  }
  if (!activeDepartmentId) return [];
  return targets.filter(target => (
    target.scope === 'department' && target.departmentId === activeDepartmentId
  ));
}

function parseKnowledgeTargets(raw: unknown): KnowledgeReviewTarget[] {
  if (!Array.isArray(raw)) return [];
  const targets: KnowledgeReviewTarget[] = [];
  for (const value of raw) {
    if (!value || typeof value !== 'object') continue;
    const target = value as Record<string, unknown>;
    const scope = target['scope'];
    const label = target['label'];
    if (
      (scope !== 'personal' && scope !== 'department' && scope !== 'company')
      || typeof label !== 'string'
      || !label.trim()
    ) continue;
    if (scope === 'department') {
      if (typeof target['departmentId'] === 'string' && target['departmentId']) {
        targets.push({ scope, label, departmentId: target['departmentId'] });
      }
      continue;
    }
    targets.push({ scope, label });
  }
  return targets;
}

function parseKnowledgeReviewAction(raw: unknown): {
  action: string;
  reviewId: string;
  targetKey: string;
} {
  const outer = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const event = outer['event'] && typeof outer['event'] === 'object'
    ? outer['event'] as Record<string, unknown>
    : outer;
  const action = event['action'] && typeof event['action'] === 'object'
    ? event['action'] as Record<string, unknown>
    : {};
  const value = action['value'];
  let parsed: Record<string, unknown> = {};
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value) as Record<string, unknown>; } catch { /* invalid action */ }
  } else if (value && typeof value === 'object') {
    parsed = value as Record<string, unknown>;
  }
  return {
    action: String(parsed['action'] ?? ''),
    reviewId: String(parsed['reviewId'] ?? ''),
    targetKey: String(parsed['targetKey'] ?? ''),
  };
}

function knowledgeReviewKey(reviewId: string): string {
  return `${KNOWLEDGE_REVIEW_CACHE_PREFIX}${reviewId}`;
}

function knowledgeReviewLockKey(reviewId: string): string {
  return `${KNOWLEDGE_REVIEW_CACHE_PREFIX}lock:${reviewId}`;
}

function knowledgeReviewDecisionKey(reviewId: string): string {
  return `${KNOWLEDGE_REVIEW_CACHE_PREFIX}decision:${reviewId}`;
}

function reviewTargetKey(target: KnowledgeReviewTarget): string {
  return target.scope === 'department'
    ? `${target.scope}:${target.departmentId}`
    : target.scope;
}

function buildKnowledgeReviewCard(request: KnowledgeReviewRequest): string {
  const detailBlocks = reviewDetailBlocks(request);
  const noun = reviewNoun(request);
  const card = {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      title: {
        tag: 'plain_text',
        content: `Review ${request.targets.every(target => target.scope === 'personal') ? 'personal' : 'shared'} ${noun} before ${reviewActionVerb(request)}`,
      },
      template: 'blue',
    },
    elements: [
      ...detailBlocks.map(details => ({
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: details,
        },
      })),
      {
        tag: 'note',
        elements: [{
          tag: 'plain_text',
          content: request.targets.every(target => target.scope === 'personal')
            ? `Personal ${noun} stays private to you and is saved only after your review.`
            : `Department ${noun} stays inside that department. Company ${noun} is company-wide. Shared targets require a different authorized approver.`,
        }],
      },
      { tag: 'hr' },
      {
        tag: 'action',
        actions: request.targets.map(target => ({
          tag: 'button',
          text: { tag: 'plain_text', content: reviewTargetButtonLabel(request, target) },
          type: 'primary',
          value: {
            action: 'knowledge_review_publish',
            reviewId: request.reviewId,
            targetKey: reviewTargetKey(target),
          },
          confirm: {
            title: { tag: 'plain_text', content: `Confirm shared ${noun} target` },
            text: {
              tag: 'plain_text',
              content: request.kind === 'memory'
                ? target.scope === 'company'
                  ? 'Send these exact facts for company-admin approval?'
                  : `Send these exact facts for ${target.label} department-manager approval?`
                : target.scope === 'personal'
                  ? `Save this exact ${noun} change to your private knowledge?`
                  : target.scope === 'company'
                    ? `Send this exact ${noun} change for company-administrator approval?`
                    : `Send this exact ${noun} change for ${target.label} department-manager approval?`,
            },
          },
        })),
      },
      {
        tag: 'action',
        actions: [{
          tag: 'button',
          text: { tag: 'plain_text', content: 'Cancel' },
          value: {
            action: 'knowledge_review_cancel',
            reviewId: request.reviewId,
          },
        }],
      },
    ],
  };
  return JSON.stringify({ msg_type: 'interactive', card: JSON.stringify(card) });
}

function reviewTargetButtonLabel(request: KnowledgeReviewRequest, target: KnowledgeReviewTarget): string {
  const action = request.kind === 'memory' ? 'Save to'
    : request.action === 'delete' ? 'Remove from' : 'Send to';
  return target.scope === 'department'
    ? `${action} Department: ${target.label}`
    : target.scope === 'company'
      ? `${action} Company`
      : `${request.action === 'delete' ? 'Remove from' : 'Save to'} Personal`;
}

function buildKnowledgeReviewProcessingCard(request: KnowledgeReviewRequest): string {
  const card = {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      title: { tag: 'plain_text', content: `${titleCase(reviewNoun(request))} decision received` },
      template: 'blue',
    },
    elements: [{
      tag: 'div',
      text: {
        tag: 'plain_text',
        content: `Processing the exact reviewed ${reviewNoun(request)} change. This card will update when Divo finishes.`,
      },
    }],
  };
  return JSON.stringify({ msg_type: 'interactive', card: JSON.stringify(card) });
}

function buildKnowledgeReviewResolvedCard(
  status: 'saved' | 'pending' | 'cancelled' | 'denied' | 'failed',
  request: KnowledgeReviewRequest,
  target?: KnowledgeReviewTarget,
): string {
  const noun = reviewNoun(request);
  const copy = status === 'saved'
    ? request.kind === 'memory'
      ? `Saved ${request.facts.length} reviewed fact${request.facts.length === 1 ? '' : 's'} to ${target?.label ?? 'memory'}.`
      : successfulReviewMessage(request, target?.label ?? noun)
    : status === 'pending'
      ? `Reviewed for ${target?.label ?? noun}. The exact request is waiting for ${target?.scope === 'company' ? 'company administrator' : 'department manager'} approval.`
      : status === 'cancelled'
        ? request.kind === 'memory' ? 'Cancelled. No memory was saved.' : `Cancelled. No ${noun} change was saved.`
        : status === 'denied'
          ? 'Not saved because your access to this target changed.'
          : request.kind === 'memory'
            ? 'Memory was not saved because the backend rejected or could not complete the request.'
            : `${titleCase(noun)} was not changed because the backend rejected or could not complete the request.`;
  const card = {
    header: {
      title: { tag: 'plain_text', content: status === 'saved' ? `${titleCase(noun)} saved` : `${titleCase(noun)} review closed` },
      template: status === 'saved' ? 'green' : status === 'pending' ? 'blue' : 'grey',
    },
    elements: [{ tag: 'div', text: { tag: 'plain_text', content: copy } }],
  };
  return JSON.stringify({ msg_type: 'interactive', card: JSON.stringify(card) });
}

function reviewNoun(request: KnowledgeReviewRequest): string {
  return request.kind === 'memory' ? 'memory' : request.kind === 'skill' ? 'procedure' : 'file';
}

function reviewActionVerb(request: KnowledgeReviewRequest): string {
  return request.action === 'delete' ? 'removing' : request.kind === 'skill' ? 'publishing' : 'saving';
}

function reviewDetailBlocks(request: KnowledgeReviewRequest): string[] {
  if (request.kind === 'memory') {
    const facts = request.facts
      .map((fact, index) => `${index + 1}. ${escapeLarkMarkdown(fact)}`)
      .join('\n');
    return [`**Only these exact facts will be saved:**\n${facts}`];
  }
  if (request.action === 'delete') {
    return [`**Resource to remove:** ${escapeLarkMarkdown(request.logicalKey)}`];
  }
  const content = asRecord(request.content);
  if (request.kind === 'skill') {
    const name = typeof content['name'] === 'string' ? content['name'] : request.logicalKey;
    const summary = typeof content['summary'] === 'string' ? content['summary'] : '';
    const markdown = typeof content['markdown'] === 'string' ? content['markdown'] : '';
    return exactSkillReviewBlocks({ name, summary, markdown });
  }
  const fileName = typeof content['fileName'] === 'string' ? content['fileName'] : request.logicalKey;
  const mimeType = typeof content['mimeType'] === 'string' ? content['mimeType'] : 'unknown';
  const sizeBytes = typeof content['sizeBytes'] === 'number' ? content['sizeBytes'] : 0;
  return [[
    `**File:** ${escapeLarkMarkdown(fileName)}`,
    `**Type:** ${escapeLarkMarkdown(mimeType)}`,
    `**Size:** ${formatBytes(sizeBytes)}`,
  ].join('\n')];
}

function successfulReviewMessage(request: KnowledgeReviewRequest, targetLabel: string): string {
  if (request.kind === 'memory') {
    return `${request.facts.length} fact${request.facts.length === 1 ? '' : 's'} saved to ${targetLabel}.`;
  }
  return `${titleCase(reviewNoun(request))} ${request.action === 'delete' ? 'removed from' : 'saved to'} ${targetLabel}.`;
}

function openedReviewMessage(request: KnowledgeReviewRequest): string {
  if (request.kind === 'memory') return KNOWLEDGE_REVIEW_OPENED_MESSAGE;
  return `The exact ${reviewNoun(request)} change is waiting in a Lark review card. Nothing changes until you approve the target.`;
}

function cancelledReviewMessage(request: KnowledgeReviewRequest): string {
  return request.kind === 'memory'
    ? 'Cancelled. No memory was saved.'
    : `Cancelled. No ${reviewNoun(request)} change was saved.`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function escapeLarkMarkdown(value: string): string {
  return value.replace(/([\\*_~`[\]])/g, '\\$1');
}

function knowledgeReviewToast(ok: boolean, content: string): CardCallbackResult {
  return {
    ok,
    responseBody: {
      toast: { type: ok ? 'success' : 'error', content },
    },
  };
}

function knowledgeReviewImmediateCard(cardEnvelope: string): CardCallbackResult {
  const envelope = JSON.parse(cardEnvelope) as { card: string };
  return {
    ok: true,
    responseBody: JSON.parse(envelope.card) as Record<string, unknown>,
  };
}
