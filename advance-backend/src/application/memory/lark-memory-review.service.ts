import { randomUUID } from 'node:crypto';
import { dynamicTool } from 'ai';
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

/**
 * Lark review cards for durable memory facts.
 *
 * Lived inside the knowledge-share module until file sharing was removed. It
 * never depended on any of it — memory review is about facts a member agrees
 * to remember, not about granting access to a file.
 */

const MEMORY_REVIEW_CACHE_PREFIX = 'lark:memory-review:';
const MEMORY_REVIEW_TTL_SECONDS = 24 * 60 * 60;

const MemoryReviewInputSchema = z.object({
  proposalId: z.string().min(1).max(120),
  bullets: z.array(z.string().trim().min(1).max(500)).min(1).max(10),
}).strict();

interface MemoryReviewTarget {
  scope: 'personal' | 'department' | 'company';
  label: string;
  departmentId?: string;
}

interface MemoryReviewRequest {
  reviewId: string;
  proposalId: string;
  requesterUserId: string;
  requesterOpenId: string;
  companyId: string;
  chatId: string;
  facts: string[];
  targets: MemoryReviewTarget[];
  ready: boolean;
  cardMessageId?: string;
}

export interface LarkMemoryReviewToolInput {
  runContext: RunContext;
  perm: PermissionResult;
  chatId: string;
  isSkillResolved: () => boolean;
}

export interface LarkMemoryReviewToolFactory {
  createMemoryReviewTool(input: LarkMemoryReviewToolInput): unknown;
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

export class LarkMemoryReviewService implements LarkMemoryReviewToolFactory {
  private readonly log: Logger;

  constructor(
    private readonly cache: CachePort,
    private readonly larkAdapter: LarkChannelAdapter,
    private readonly toolExecutor: ToolExecutor,
    private readonly permissions: PermissionService,
    private readonly approvalGate: ApprovalGateService,
    logger: Logger,
  ) {
    this.log = logger.child({ service: 'lark-memory-review' });
  }

  createMemoryReviewTool(input: LarkMemoryReviewToolInput): unknown {
    return dynamicTool({
      description: 'Open the Lark requester review card for durable memory facts. Use only after the Share Memory skill is resolved.',
      inputSchema: MemoryReviewInputSchema,
      execute: async (raw: unknown): Promise<string> => {
        if (!input.isSkillResolved()) {
          return 'Memory review was not opened because the Share Memory skill has not been resolved for this request.';
        }
        if (!input.runContext.userExternalId) {
          return 'Memory review is unavailable because the requester identity is missing.';
        }

        const parsed = MemoryReviewInputSchema.safeParse(raw);
        if (!parsed.success) {
          return 'Memory review was not opened because the proposed facts are invalid.';
        }
        const authority = await this.checkAuthority(input.runContext, input.perm);
        if (!authority.ok) return authority.message;

        const reviewId = randomUUID();
        const request: MemoryReviewRequest = {
          reviewId,
          proposalId: parsed.data.proposalId,
          requesterUserId: String(input.runContext.userId),
          requesterOpenId: input.runContext.userExternalId,
          companyId: String(input.runContext.companyId),
          chatId: input.chatId,
          facts: parsed.data.bullets,
          targets: authority.targets,
          ready: false,
        };
        const stored = await this.cache.set(
          memoryReviewKey(reviewId),
          request,
          MEMORY_REVIEW_TTL_SECONDS,
        );
        if (!stored.ok) {
          this.log.error('memory_review.cache_write_failed', { reviewId });
          return 'Memory review could not be opened. Please try again.';
        }

        const sent = await this.larkAdapter.sendCardToChat(
          input.chatId,
          buildMemoryReviewCard(request),
        );
        if (!sent.ok) {
          await this.cache.del(memoryReviewKey(reviewId));
          this.log.warn('memory_review.card_send_failed', {
            reviewId,
            error: sent.error.message,
          });
          return 'Memory review could not be delivered. Please try again.';
        }
        const readyRequest: MemoryReviewRequest = {
          ...request,
          cardMessageId: sent.value.messageId,
          ready: true,
        };
        const cardStateStored = await this.cache.set(
          memoryReviewKey(reviewId),
          readyRequest,
          MEMORY_REVIEW_TTL_SECONDS,
        );
        if (!cardStateStored.ok) {
          await this.cache.setNx(
            memoryReviewLockKey(reviewId),
            'card_state_failed',
            MEMORY_REVIEW_TTL_SECONDS,
          );
          await this.cache.del(memoryReviewKey(reviewId));
          await this.larkAdapter.updateMessageById(
            sent.value.messageId,
            buildMemoryReviewResolvedCard('failed', readyRequest),
          );
          this.log.error('memory_review.card_state_write_failed', { reviewId });
          return 'Memory review could not be opened safely. Nothing was saved.';
        }
        this.log.info('memory_review.opened', {
          reviewId,
          requesterUserId: request.requesterUserId,
          targetCount: request.targets.length,
          factCount: request.facts.length,
        });
        return 'The exact facts are waiting in a Lark review card. Nothing is saved until you approve one target.';
      },
    } as any);
  }

  isMemoryReviewAction(cardEvent: unknown): boolean {
    const { action } = parseMemoryReviewAction(cardEvent);
    return action === 'memory_review_publish' || action === 'memory_review_cancel';
  }

  async handle(
    cardEvent: unknown,
    actor: AuthenticatedCardActor,
  ): Promise<CardCallbackResult> {
    const parsed = parseMemoryReviewAction(cardEvent);
    if (!parsed.reviewId) return memoryReviewToast(false, 'This memory review is invalid.');

    const cached = await this.cache.get<MemoryReviewRequest>(memoryReviewKey(parsed.reviewId));
    if (!cached.ok || !cached.value) {
      return memoryReviewToast(false, 'This memory review expired or was already resolved.');
    }
    const request = cached.value;
    if (!request.ready) {
      return memoryReviewToast(false, 'This memory review was not opened safely.');
    }
    if (
      actor.companyId !== request.companyId
      || actor.userId !== request.requesterUserId
      || actor.openId !== request.requesterOpenId
    ) {
      this.log.warn('memory_review.unauthorized_actor', {
        reviewId: request.reviewId,
        actorUserId: actor.userId,
        requesterUserId: request.requesterUserId,
      });
      return memoryReviewToast(false, 'Only the person who opened this review can decide it.');
    }

    const selected = parsed.action === 'memory_review_publish'
      ? request.targets.find(target => memoryTargetKey(target) === parsed.targetKey)
      : undefined;
    if (parsed.action === 'memory_review_publish' && !selected) {
      return memoryReviewToast(false, 'That memory target is not part of this review.');
    }

    const lock = await this.cache.setNx(
      memoryReviewLockKey(request.reviewId),
      actor.userId,
      MEMORY_REVIEW_TTL_SECONDS,
    );
    if (!lock.ok || !lock.value) {
      return memoryReviewToast(false, 'This memory review is already being processed.');
    }
    const claimed = await this.cache.del(memoryReviewKey(request.reviewId));
    if (!claimed.ok) {
      await this.finishRequest(request, buildMemoryReviewResolvedCard('failed', request));
      return memoryReviewToast(false, 'Divo could not claim this review safely. Nothing was saved.');
    }

    if (parsed.action === 'memory_review_cancel') {
      await this.finishRequest(request, buildMemoryReviewResolvedCard('cancelled', request));
      return memoryReviewToast(true, 'Cancelled. No memory was saved.');
    }

    const live = await this.resolveLiveAuthority(actor, request.chatId);
    if (!live.ok) {
      await this.finishRequest(request, buildMemoryReviewResolvedCard('failed', request));
      return memoryReviewToast(false, `${live.message} Nothing was saved; open a new review to retry.`);
    }
    const liveTarget = live.targets.find(target => memoryTargetKey(target) === parsed.targetKey);
    if (!liveTarget) {
      await this.finishRequest(request, buildMemoryReviewResolvedCard('denied', request));
      return memoryReviewToast(false, 'Your access changed. This target is no longer available.');
    }

    const args: Record<string, unknown> = {
      operation: 'publish',
      scope: liveTarget.scope,
      facts: request.facts,
      ...(liveTarget.departmentId ? { departmentId: liveTarget.departmentId } : {}),
    };
    const outcome = await this.toolExecutor.executeForRuntime({
      toolId: 'memoryPublishing',
      args,
      runContext: live.runContext,
      perm: live.perm,
      approvalGate: this.approvalGate,
      chatId: request.chatId,
      expectedAction: 'create',
    });

    if (outcome.status === 'success') {
      await this.finishRequest(request, buildMemoryReviewResolvedCard('saved', request, liveTarget.label));
      return memoryReviewToast(true, `${request.facts.length} fact${request.facts.length === 1 ? '' : 's'} saved to ${liveTarget.label}.`);
    }
    if (outcome.status === 'approval_required') {
      await this.finishRequest(request, buildMemoryReviewResolvedCard('pending', request, liveTarget.label));
      return memoryReviewToast(true, 'Reviewed. The exact request is waiting for manager approval.');
    }

    await this.finishRequest(request, buildMemoryReviewResolvedCard('failed', request));
    this.log.warn('memory_review.publish_failed', {
      reviewId: request.reviewId,
      status: outcome.status,
    });
    return memoryReviewToast(false, outcome.message ?? 'Memory could not be saved.');
  }

  private async checkAuthority(
    runContext: RunContext,
    perm: PermissionResult,
  ): Promise<{ ok: true; targets: MemoryReviewTarget[] } | { ok: false; message: string }> {
    const outcome = await this.toolExecutor.executeForRuntime({
      toolId: 'memoryPublishing',
      args: { operation: 'check_authority' },
      runContext,
      perm,
      expectedAction: 'read',
    });
    if (outcome.status !== 'success') {
      return { ok: false, message: outcome.message ?? 'Memory sharing is unavailable.' };
    }
    const result = outcome.result as Record<string, unknown> | undefined;
    if (result?.['availability'] !== 'available') {
      return { ok: false, message: 'Memory sharing is unavailable.' };
    }
    const targets = parseMemoryTargets(result['targets']);
    return targets.length > 0
      ? { ok: true, targets }
      : { ok: false, message: 'You do not have an available memory target.' };
  }

  private async resolveLiveAuthority(
    actor: AuthenticatedCardActor,
    chatId: string,
  ): Promise<
    | { ok: true; runContext: RunContext; perm: PermissionResult; targets: MemoryReviewTarget[] }
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
    const authority = await this.checkAuthority(runContext, resolved.value);
    return authority.ok
      ? { ok: true, runContext, perm: resolved.value, targets: authority.targets }
      : authority;
  }

  private async finishRequest(request: MemoryReviewRequest, card: string): Promise<void> {
    if (request.cardMessageId) {
      const updated = await this.larkAdapter.updateMessageById(request.cardMessageId, card);
      if (!updated.ok) {
        this.log.warn('memory_review.card_update_failed', {
          reviewId: request.reviewId,
          error: updated.error.message,
        });
      }
    }
  }
}

function parseMemoryTargets(raw: unknown): MemoryReviewTarget[] {
  if (!Array.isArray(raw)) return [];
  const targets: MemoryReviewTarget[] = [];
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

function parseMemoryReviewAction(raw: unknown): {
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

function memoryReviewKey(reviewId: string): string {
  return `${MEMORY_REVIEW_CACHE_PREFIX}${reviewId}`;
}

function memoryReviewLockKey(reviewId: string): string {
  return `${MEMORY_REVIEW_CACHE_PREFIX}lock:${reviewId}`;
}

function memoryTargetKey(target: MemoryReviewTarget): string {
  return target.scope === 'department'
    ? `${target.scope}:${target.departmentId}`
    : target.scope;
}

function buildMemoryReviewCard(request: MemoryReviewRequest): string {
  const facts = request.facts
    .map((fact, index) => `${index + 1}. ${escapeLarkMarkdown(fact)}`)
    .join('\n');
  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: 'Review memory before saving' },
      template: 'blue',
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**Only these exact facts will be saved:**\n${facts}`,
        },
      },
      {
        tag: 'note',
        elements: [{
          tag: 'plain_text',
          content: 'Choose one target. To change the facts, cancel and ask Divo to make a new review.',
        }],
      },
      { tag: 'hr' },
      {
        tag: 'action',
        actions: request.targets.map(target => ({
          tag: 'button',
          text: { tag: 'plain_text', content: `Save to ${target.label}` },
          type: 'primary',
          value: JSON.stringify({
            action: 'memory_review_publish',
            reviewId: request.reviewId,
            targetKey: memoryTargetKey(target),
          }),
        })),
      },
      {
        tag: 'action',
        actions: [{
          tag: 'button',
          text: { tag: 'plain_text', content: 'Cancel' },
          value: JSON.stringify({
            action: 'memory_review_cancel',
            reviewId: request.reviewId,
          }),
        }],
      },
    ],
  };
  return JSON.stringify({ msg_type: 'interactive', card: JSON.stringify(card) });
}

function buildMemoryReviewResolvedCard(
  status: 'saved' | 'pending' | 'cancelled' | 'denied' | 'failed',
  request: MemoryReviewRequest,
  targetLabel?: string,
): string {
  const copy = {
    saved: `Saved ${request.facts.length} reviewed fact${request.facts.length === 1 ? '' : 's'} to ${targetLabel ?? 'memory'}.`,
    pending: `Reviewed for ${targetLabel ?? 'memory'}. The exact request is waiting for manager approval.`,
    cancelled: 'Cancelled. No memory was saved.',
    denied: 'Not saved because your access to this target changed.',
    failed: 'Memory was not saved because the backend rejected or could not complete the request.',
  }[status];
  const card = {
    header: {
      title: { tag: 'plain_text', content: status === 'saved' ? 'Memory saved' : 'Memory review closed' },
      template: status === 'saved' ? 'green' : status === 'pending' ? 'blue' : 'grey',
    },
    elements: [{ tag: 'div', text: { tag: 'plain_text', content: copy } }],
  };
  return JSON.stringify({ msg_type: 'interactive', card: JSON.stringify(card) });
}

function escapeLarkMarkdown(value: string): string {
  return value.replace(/([\\*_~`[\]])/g, '\\$1');
}

function memoryReviewToast(ok: boolean, content: string): CardCallbackResult {
  return {
    ok,
    responseBody: {
      toast: { type: ok ? 'success' : 'error', content },
    },
  };
}
