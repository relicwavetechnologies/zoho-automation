import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../../generated/prisma';
import type { OrchestrationEngine } from '../orchestration/engine/core';
import type { ChannelAdapter } from '../channels/channel.adapter';
import type { ChannelIdentityRepoPort } from '../../infrastructure/persistence/channel-identity.repository';
import type { Logger } from '../../shared/logger';
import type { Clock } from '../../shared/clock';
import type { IncomingMessage } from '../../domain/channel/incoming-message';
import type { RunContext } from '../../domain/orchestration/run-context';
import type { ConversationHandle } from '../channels/channel.adapter';
import { asCompanyId, asUserId, asChatId, asCorrelationId, asDepartmentId } from '../../shared/ids';
import { asCompanyRoleSlug } from '../../domain/permissions/company-role';
import { scheduleConfigSchema } from './schedule-config';
import { getNextScheduledRunAt } from './schedule-calculator';
import { readDeliveryChannel, readDeliveryTarget } from './scheduled-workflow-control.service';

const STALE_CLAIM_MS = 10 * 60 * 1000;
const MAX_DUE_PER_POLL = 5;
const CURRENT_CHAT_DELIVERY_LINE = /^\s*Deliver to:\s+.*lark_current_chat\s*$/m;

export function usesLockedCurrentChatDelivery(compiledPrompt: string): boolean {
  return CURRENT_CHAT_DELIVERY_LINE.test(compiledPrompt);
}

export function buildScheduledExecutionPrompt(
  compiledPrompt: string,
  lockedChatId: string,
  deliveryChannel: 'lark' | 'desktop' = 'lark',
  deliveryTarget: 'origin_chat' | 'creator_dm' = 'origin_chat',
): string {
  if (deliveryTarget === 'creator_dm') {
    return [
      compiledPrompt,
      '',
      'RUNTIME DELIVERY OVERRIDE:',
      '- Return the completed result as your final reply. The runtime will deliver it to the authenticated schedule creator\'s Lark DM.',
      '- Do not call larkMessaging merely to deliver the final result and do not search for the creator or a destination chat.',
      '- External actions explicitly required by the scheduled task are still allowed subject to normal permissions and approvals.',
    ].join('\n');
  }
  if (deliveryChannel === 'desktop') {
    return [
      compiledPrompt,
      '',
      'RUNTIME DELIVERY OVERRIDE:',
      `- Return the completed result to the originating Divo desktop conversation (${lockedChatId}) as your final reply.`,
      '- Do not use a messaging tool merely to deliver the final reply; the runtime persists it in that conversation.',
      '- External actions explicitly required by the scheduled task are still allowed subject to normal permissions and approvals.',
    ].join('\n');
  }
  if (!usesLockedCurrentChatDelivery(compiledPrompt)) {
    return compiledPrompt;
  }

  const rewritten = compiledPrompt.replace(
    CURRENT_CHAT_DELIVERY_LINE,
    '   Deliver to: runtime_locked_current_chat (system-delivered; do not send manually)',
  );

  return [
    rewritten,
    '',
    'RUNTIME DELIVERY OVERRIDE:',
    `- The destination for lark_current_chat is already locked by the runtime to this exact current Lark conversation (${lockedChatId}).`,
    '- Do NOT call larkMessaging, do NOT list or search chats, and do NOT send or repost the result to any other chat, group, or DM.',
    '- Produce the completed delivery content as your final reply only. The runtime will deliver that reply to the locked current chat.',
  ].join('\n');
}

export interface ScheduledWorkflowServiceDeps {
  readonly prisma:              PrismaClient;
  readonly engine:              OrchestrationEngine;
  readonly channelAdapters:     Readonly<{
    lark: ChannelAdapter;
    larkDm: ChannelAdapter;
    desktop: ChannelAdapter;
  }>;
  readonly channelIdentityRepo: ChannelIdentityRepoPort;
  readonly logger:              Logger;
  readonly clock:               Clock;
  readonly pollIntervalMs:      number;
}

export class ScheduledWorkflowService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private suspendedReason: string | null = null;
  private readonly log: Logger;

  constructor(private readonly deps: ScheduledWorkflowServiceDeps) {
    this.log = deps.logger.child({ service: 'scheduled-workflow' });
  }

  start(): void {
    if (this.timer) return;
    this.log.info('scheduler.started', { pollIntervalMs: this.deps.pollIntervalMs });
    this.timer = setInterval(() => {
      void this.processDueWorkflows().catch(e => this.handleFailure(e));
    }, this.deps.pollIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      this.log.info('scheduler.stopped');
    }
  }

  private async processDueWorkflows(): Promise<void> {
    if (this.running || this.suspendedReason) return;
    this.running = true;

    try {
      const now = this.deps.clock.now();
      const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS);

      const due = await this.deps.prisma.scheduledWorkflow.findMany({
        where: {
          status: { in: ['active', 'scheduled_active'] },
          scheduleEnabled: true,
          nextRunAt: { lte: now },
          OR: [
            { claimedAt: null },
            { claimedAt: { lt: staleBefore } },
          ],
        },
        orderBy: { nextRunAt: 'asc' },
        take: MAX_DUE_PER_POLL,
        select: { id: true, nextRunAt: true },
      });

      this.log.debug('scheduler.poll', { dueCount: due.length });

      for (const candidate of due) {
        const claimToken = randomUUID();
        const claimed = await this.deps.prisma.scheduledWorkflow.updateMany({
          where: {
            id: candidate.id,
            status: { in: ['active', 'scheduled_active'] },
            scheduleEnabled: true,
            nextRunAt: candidate.nextRunAt,
            OR: [
              { claimedAt: null },
              { claimedAt: { lt: staleBefore } },
            ],
          },
          data: { claimToken, claimedAt: now },
        });

        if (claimed.count === 0) continue;

        try {
          await this.executeWorkflow(candidate.id, candidate.nextRunAt ?? now);
        } catch (e) {
          this.log.error('scheduler.execute.crashed', {
            workflowId: candidate.id,
            error: e instanceof Error ? e.message : String(e),
          });
          await this.markFailed(
            candidate.id,
            candidate.nextRunAt ?? now,
            `Unhandled: ${e instanceof Error ? e.message : String(e)}`,
          ).catch(() => { /* best effort */ });
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async executeWorkflow(workflowId: string, scheduledFor: Date): Promise<void> {
    const workflow = await this.deps.prisma.scheduledWorkflow.findUnique({
      where: { id: workflowId },
    });
    if (!workflow) {
      this.log.warn('scheduler.workflow_not_found', { workflowId });
      return;
    }

    this.log.info('scheduler.execute.start', {
      workflowId,
      name: workflow.name,
      scheduledFor: scheduledFor.toISOString(),
    });

    const configResult = scheduleConfigSchema.safeParse(workflow.scheduleConfigJson);
    if (!configResult.success) {
      await this.markFailed(workflowId, scheduledFor, 'Invalid schedule configuration');
      return;
    }

    if (!workflow.createdByUserId) {
      await this.markFailed(workflowId, scheduledFor, 'Workflow has no creator user');
      return;
    }

    const identityResult = await this.deps.channelIdentityRepo.resolveByUserId(workflow.createdByUserId);
    if (!identityResult.ok || !identityResult.value) {
      await this.markFailed(workflowId, scheduledFor, 'Could not resolve creator identity');
      return;
    }
    const identity = identityResult.value;

    const deliveryChannel = readDeliveryChannel(workflow.outputConfigJson);
    const deliveryTarget = readDeliveryTarget(workflow.outputConfigJson);
    const targetChatId = deliveryTarget === 'creator_dm'
      ? identity.larkOpenId
      : workflow.originChatId;
    if (!targetChatId) {
      const reason = deliveryTarget === 'creator_dm'
        ? 'No delivery target (creator has no connected Lark identity)'
        : 'No delivery target (missing originChatId)';
      await this.markFailed(workflowId, scheduledFor, reason);
      return;
    }

    const currentChatDeliveryLocked = deliveryTarget === 'origin_chat'
      && (deliveryChannel === 'desktop' || usesLockedCurrentChatDelivery(workflow.compiledPrompt));
    const executionPrompt = buildScheduledExecutionPrompt(
      workflow.compiledPrompt,
      targetChatId,
      deliveryChannel,
      deliveryTarget,
    );
    const channelAdapter = deliveryTarget === 'creator_dm'
      ? this.deps.channelAdapters.larkDm
      : this.deps.channelAdapters[deliveryChannel];

    const run = await this.deps.prisma.scheduledWorkflowRun.upsert({
      where: { workflowId_scheduledFor: { workflowId, scheduledFor } },
      create: { workflowId, scheduledFor, status: 'running', startedAt: new Date() },
      update: { status: 'running', startedAt: new Date(), finishedAt: null, errorSummary: null },
    });

    const syntheticChatId = asChatId(targetChatId);
    const syntheticCorrelationId = asCorrelationId(`sched-${run.id}`);

    const incoming: IncomingMessage = {
      channel: deliveryChannel,
      messageId: `scheduled-${run.id}` as any,
      chatId: syntheticChatId,
      chatType: 'p2p',
      userExternalId: deliveryChannel === 'lark'
        ? identity.larkOpenId ?? workflow.createdByUserId
        : workflow.createdByUserId,
      text: executionPrompt,
      attachments: [],
      timestamp: new Date().toISOString(),
      traceId: syntheticCorrelationId,
      mentions: [],
      mentionsSelf: false,
      raw: { source: 'scheduled_workflow', workflowId, runId: run.id },
    };

    const runContext: RunContext = {
      companyId:      asCompanyId(workflow.companyId),
      userId:         asUserId(workflow.createdByUserId),
      companyRole:    asCompanyRoleSlug(identity.aiRole),
      channel:        deliveryChannel,
      traceId:        `sched-${run.id}`,
      requestId:      `sched-${run.id}`,
      userExternalId: deliveryChannel === 'lark'
        ? identity.larkOpenId ?? workflow.createdByUserId
        : workflow.createdByUserId,
      chatId:         targetChatId,
      ...(deliveryTarget === 'creator_dm'
        ? { deliveryMode: 'scheduled_runtime_delivery' as const }
        : currentChatDeliveryLocked
          ? { deliveryMode: 'current_chat_only' as const }
          : {}),
      ...(workflow.departmentId
        ? { departmentId: asDepartmentId(workflow.departmentId) }
        : identity.activeDepartmentId
          ? { departmentId: asDepartmentId(identity.activeDepartmentId) }
          : {}),
    };

    const conversation: ConversationHandle = {
      channel:          deliveryChannel,
      chatId:           syntheticChatId,
      correlationId:    syntheticCorrelationId,
      replyInThread:    false,
    };

    try {
      const result = await this.deps.engine.run({
        incoming,
        runContext,
        conversation,
        channelAdapter,
      });

      const summary = result.ok
        ? result.value.finalReply.text.slice(0, 2000)
        : result.error.message.slice(0, 2000);

      await this.deps.prisma.scheduledWorkflowRun.update({
        where: { id: run.id },
        data: {
          status: result.ok ? 'succeeded' : 'failed',
          finishedAt: new Date(),
          ...(result.ok ? { resultSummary: summary } : { errorSummary: summary }),
        },
      });
    } catch (e) {
      await this.deps.prisma.scheduledWorkflowRun.update({
        where: { id: run.id },
        data: {
          status: 'failed',
          finishedAt: new Date(),
          errorSummary: (e instanceof Error ? e.message : String(e)).slice(0, 2000),
        },
      });
    }

    // Use current time as anchor — skip past all missed slots to the next future run.
    // Using scheduledFor would replay every missed day one by one.
    const nextRunAt = getNextScheduledRunAt(configResult.data, new Date());

    const isOneTimeComplete = configResult.data.type === 'one_time' && !nextRunAt;

    await this.deps.prisma.scheduledWorkflow.update({
      where: { id: workflowId },
      data: {
        lastRunAt: new Date(),
        nextRunAt,
        claimToken: null,
        claimedAt: null,
        ...(isOneTimeComplete ? {
          status: 'archived',
          scheduleEnabled: false,
          archivedAt: new Date(),
        } : {}),
      },
    });

    this.log.info('scheduler.execute.complete', {
      workflowId,
      runId: run.id,
      nextRunAt: nextRunAt?.toISOString() ?? null,
      archived: isOneTimeComplete,
    });
  }

  private async markFailed(workflowId: string, scheduledFor: Date, reason: string): Promise<void> {
    await this.deps.prisma.scheduledWorkflowRun.upsert({
      where: { workflowId_scheduledFor: { workflowId, scheduledFor } },
      create: { workflowId, scheduledFor, status: 'failed', errorSummary: reason, finishedAt: new Date() },
      update: { status: 'failed', errorSummary: reason, finishedAt: new Date() },
    });

    // Advance nextRunAt so this workflow isn't re-triggered on the next poll.
    const workflow = await this.deps.prisma.scheduledWorkflow.findUnique({
      where: { id: workflowId },
      select: { scheduleConfigJson: true },
    });
    let nextRunAt: Date | null = null;
    if (workflow) {
      const parsed = scheduleConfigSchema.safeParse(workflow.scheduleConfigJson);
      if (parsed.success) {
        nextRunAt = getNextScheduledRunAt(parsed.data, new Date());
      }
    }
    const isOneTimeComplete = !nextRunAt;

    await this.deps.prisma.scheduledWorkflow.update({
      where: { id: workflowId },
      data: {
        claimToken: null,
        claimedAt: null,
        lastRunAt: new Date(),
        nextRunAt,
        ...(isOneTimeComplete ? { status: 'archived', scheduleEnabled: false, archivedAt: new Date() } : {}),
      },
    });
    this.log.error('scheduler.execute.failed', { workflowId, reason, nextRunAt: nextRunAt?.toISOString() ?? null });
  }

  private handleFailure(error: unknown): void {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('does not exist') || msg.includes("Can't reach database") || msg.includes('connection pool')) {
      this.suspendedReason = msg.includes("Can't reach") ? 'database_unavailable' : 'table_missing';
      this.log.warn('scheduler.suspended', { reason: this.suspendedReason });
      return;
    }
    this.log.error('scheduler.poll.failed', { error: msg });
  }
}
