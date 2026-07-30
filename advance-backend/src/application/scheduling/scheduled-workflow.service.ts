import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../../generated/prisma';
import type { LarkPiRuntimeInput } from '../runtime/lark-pi-runtime.service';
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
import {
  issueScheduledRuntimeSession,
  revokeScheduledRuntimeSession,
} from './scheduled-runtime-session';

/**
 * How long past its claim a workflow may be re-claimed.
 *
 * This must exceed the longest a run can legitimately take, or a second
 * replica re-claims a run that is still in flight — `nextRunAt` is only
 * advanced after the run, so the row still looks due. Derived from the run
 * timeout rather than fixed, so raising the timeout cannot silently
 * reintroduce double execution.
 */
const staleClaimMs = (runTimeoutMs: number): number => runTimeoutMs + 5 * 60_000;
const MAX_DUE_PER_POLL = 5;

/**
 * How soon to retry a run the container was too busy to take.
 *
 * A scheduled run competes with the member's own interactive turns for their
 * single container. Treating that collision as a failure consumed the slot and
 * silently dropped the day's report; it is a "not now", not a "no".
 */
const BUSY_RETRY_MS = 5 * 60_000;

/** Codes the runtime uses when the container is occupied rather than broken. */
const BUSY_RUNTIME_CODES = new Set(['user_busy', 'capacity_full']);

function isRuntimeBusy(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && BUSY_RUNTIME_CODES.has(code);
}
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
    // A schedule written before results became DM-only still says "return this
    // to the originating conversation" in its own task text. Left standing, the
    // task and the override contradict each other and the model may try to
    // satisfy the task by posting into that room itself.
    const rewritten = usesLockedCurrentChatDelivery(compiledPrompt)
      ? compiledPrompt.replace(
          CURRENT_CHAT_DELIVERY_LINE,
          '   Deliver to: runtime_creator_dm (system-delivered; do not send manually)',
        )
      : compiledPrompt;

    return [
      rewritten,
      '',
      'RUNTIME DELIVERY OVERRIDE:',
      '- Return the completed result as your final reply. The runtime will deliver it to the authenticated schedule creator\'s Lark DM.',
      '- Do not call larkMessaging merely to deliver the final result and do not search for the creator or a destination chat.',
      '- Ignore any delivery destination named in the task above, including an originating conversation, group, or channel. This result goes to the schedule creator and nowhere else.',
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
  const rewritten = usesLockedCurrentChatDelivery(compiledPrompt)
    ? compiledPrompt.replace(
        CURRENT_CHAT_DELIVERY_LINE,
        '   Deliver to: runtime_locked_current_chat (system-delivered; do not send manually)',
      )
    : compiledPrompt;

  return [
    rewritten,
    '',
    'RUNTIME DELIVERY OVERRIDE:',
    `- The destination for lark_current_chat is already locked by the runtime to this exact current Lark conversation (${lockedChatId}).`,
    '- Do NOT use larkMessaging to deliver or repost the final result to this current chat.',
    '- Explicit messaging actions required by the scheduled task are still allowed for other recipients, subject to normal permissions and approvals.',
    '- Produce the completed delivery content as your final reply only. The runtime will deliver that reply to the locked current chat.',
  ].join('\n');
}

export interface ScheduledWorkflowServiceDeps {
  readonly prisma:              PrismaClient;
  /**
   * The container runtime. A scheduled run is an ordinary Pi run made under a
   * backend-issued session, so it lands in the member's own workspace and sees
   * the same skills their interactive turns do.
   */
  readonly piRuntime:           {
    run(input: LarkPiRuntimeInput): Promise<{ text: string }>;
  };
  readonly channelAdapters:     Readonly<{
    lark: ChannelAdapter;
    larkDm: ChannelAdapter;
    desktop: ChannelAdapter;
  }>;
  readonly channelIdentityRepo: ChannelIdentityRepoPort;
  readonly logger:              Logger;
  readonly clock:               Clock;
  readonly pollIntervalMs:      number;
  /** Bounds both the run and the lifetime of the session issued for it. */
  readonly runTimeoutMs:        number;
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
      const staleBefore = new Date(now.getTime() - staleClaimMs(this.deps.runTimeoutMs));

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

    const identityResult = await this.deps.channelIdentityRepo.resolveByUserId(
      workflow.createdByUserId,
      workflow.companyId,
    );
    if (!identityResult.ok || !identityResult.value) {
      await this.markFailed(workflowId, scheduledFor, 'Could not resolve creator identity');
      return;
    }
    const identity = identityResult.value;

    // The container is entered as the member, and a member is only identifiable
    // to it by tenant key and open id together. Without both there is nothing to
    // run as, so fail the run plainly rather than half-building a context.
    if (!identity.larkTenantKey || !identity.larkOpenId) {
      await this.markFailed(
        workflowId,
        scheduledFor,
        'Creator has no connected Lark identity to run the workflow as',
      );
      return;
    }

    // A scheduled run always reports to the creator's own Lark DM. Schedules
    // created before that rule still carry `origin_chat` and an `originChatId`,
    // and are redirected here rather than left to deliver into a shared room:
    // the run executes with one person's history and permissions, so only that
    // person should receive what it produces.
    const deliveryChannel = 'lark' as const;
    const targetChatId = identity.larkOpenId;

    const executionPrompt = buildScheduledExecutionPrompt(
      workflow.compiledPrompt,
      targetChatId,
      deliveryChannel,
      'creator_dm',
    );
    const channelAdapter = this.deps.channelAdapters.larkDm;

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
      userExternalId: identity.larkOpenId,
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
      // Always the Lark identity: this is who the run executes as, which is
      // separate from where the reply is sent.
      tenantId:       identity.larkTenantKey,
      userExternalId: identity.larkOpenId,
      chatId:         targetChatId,
      deliveryMode:   'scheduled_runtime_delivery' as const,
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

    // One thread per workflow, not per run.
    //
    // This does NOT control the workspace — that lives on the per-user volume
    // and persists regardless. What it keys is the Pi session transcript, so
    // each run replays the previous ones. For a compiled, self-contained
    // scheduled prompt that history is not needed and grows without bound; a
    // long-lived daily workflow will eventually need a per-run session scope.
    const threadId = `scheduled-workflow:${workflowId}`;
    let sessionId: string | undefined;
    let retryAfterBusyAt: Date | undefined;

    try {
      const session = await issueScheduledRuntimeSession(this.deps.prisma, {
        companyId:     workflow.companyId,
        userId:        workflow.createdByUserId,
        role:          identity.aiRole,
        larkTenantKey: identity.larkTenantKey!,
        larkOpenId:    identity.larkOpenId!,
        runTimeoutMs:  this.deps.runTimeoutMs,
      });
      sessionId = session.sessionId;

      const { text } = await this.deps.piRuntime.run({
        incoming,
        runContext,
        conversation,
        threadId,
      });

      // Pi returns the reply; unlike the engine it does not deliver it, so the
      // scheduler sends it through the adapter it already chose above.
      //
      // A scheduled run is only useful if it arrives. Channel adapters report
      // failure by returning `err`, not by throwing, so an unread result here
      // would record a green run for a report nobody received — every day,
      // silently. The run is therefore no better than its delivery.
      const reply = text.trim();
      if (!reply) {
        throw new Error('Run produced no reply to deliver');
      }
      const delivered = await channelAdapter.sendFinalReply(conversation, {
        kind: 'final',
        text: reply,
        format: 'markdown',
      });
      if (!delivered.ok) {
        throw new Error(`Delivery failed: ${delivered.error.message}`);
      }

      await this.deps.prisma.scheduledWorkflowRun.update({
        where: { id: run.id },
        data: {
          status: 'succeeded',
          finishedAt: new Date(),
          resultSummary: reply.slice(0, 2000),
        },
      });
    } catch (e) {
      if (isRuntimeBusy(e)) {
        retryAfterBusyAt = new Date(this.deps.clock.now().getTime() + BUSY_RETRY_MS);
      }
      await this.deps.prisma.scheduledWorkflowRun.update({
        where: { id: run.id },
        data: {
          status: 'failed',
          finishedAt: new Date(),
          errorSummary: (e instanceof Error ? e.message : String(e)).slice(0, 2000),
        },
      });
    } finally {
      // The run is already recorded either way, so a failed revoke must not
      // change its outcome. The session expires on its own regardless.
      if (sessionId) {
        await revokeScheduledRuntimeSession(this.deps.prisma, sessionId).catch(error => {
          this.log.warn('scheduler.session_revoke_failed', {
            workflowId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    }

    // Use current time as anchor — skip past all missed slots to the next future run.
    // Using scheduledFor would replay every missed day one by one.
    const naturalNextRunAt = getNextScheduledRunAt(configResult.data, new Date());
    // A busy container should be retried before the next natural slot, but must
    // never delay one that is already sooner.
    const nextRunAt = retryAfterBusyAt
      && (!naturalNextRunAt || retryAfterBusyAt < naturalNextRunAt)
      ? retryAfterBusyAt
      : naturalNextRunAt;

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
