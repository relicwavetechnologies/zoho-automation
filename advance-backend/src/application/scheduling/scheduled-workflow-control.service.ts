import type { PrismaClient, ScheduledWorkflowStatus } from '../../generated/prisma';
import type { RunContext } from '../../domain/orchestration/run-context';
import type { Clock } from '../../shared/clock';
import { scheduleConfigSchema, type ScheduleConfig } from './schedule-config';
import { formatScheduledSlot, getNextScheduledRunAt } from './schedule-calculator';

export type ScheduleCreateInput = {
  readonly name: string;
  readonly intent: string;
  readonly scheduleType: 'one_time' | 'hourly' | 'daily' | 'weekly' | 'monthly';
  readonly timezone: string;
  readonly runAt?: string | undefined;
  readonly intervalHours?: number | undefined;
  readonly minute?: number | undefined;
  readonly hour?: number | undefined;
  readonly timeMinute?: number | undefined;
  readonly daysOfWeek?: readonly string[] | undefined;
  readonly dayOfMonth?: number | undefined;
  readonly delivery: 'current_conversation' | 'creator_lark_dm';
};

export type ScheduledWorkflowSummary = {
  readonly id: string;
  readonly name: string;
  readonly scheduleType: string;
  readonly status: string;
  readonly timezone: string;
  readonly nextRunAt: string | null;
  readonly lastRunAt: string | null;
  readonly deliveryChannel: 'lark' | 'desktop';
  readonly deliveryTarget: 'origin_chat' | 'creator_dm';
};

export class ScheduledWorkflowControlError extends Error {
  constructor(
    readonly reason: 'bad_args' | 'not_found' | 'unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'ScheduledWorkflowControlError';
  }
}

/**
 * Single write/read authority for user-owned scheduled workflows.
 * Both the server supervisor tools and the desktop gateway tool call this
 * service so schedule state transitions cannot drift between agent paths.
 */
export class ScheduledWorkflowControlService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly clock: Pick<Clock, 'now'> = { now: () => new Date() },
  ) {}

  async create(runContext: RunContext, input: ScheduleCreateInput): Promise<{
    schedule: ScheduledWorkflowSummary;
    nextRunLabel: string;
  }> {
    if (runContext.channel !== 'desktop' && runContext.channel !== 'lark') {
      throw new ScheduledWorkflowControlError(
        'unavailable',
        `Scheduling is not available from the ${runContext.channel} channel.`,
      );
    }

    // Every schedule reports back to the person who created it, in their own
    // Lark DM, whatever conversation they set it up from. A run delivering into
    // a shared room would answer with whatever that one creator's private
    // history and permissions allow, in front of people who never asked for it —
    // `input.delivery` is therefore accepted and ignored, and the returned
    // summary tells the caller where results will actually arrive.
    {
      const larkConnection = await this.prisma.integrationConnection.findFirst({
        where: {
          ownerUserId: String(runContext.userId),
          provider: 'lark',
          status: 'connected',
          revokedAt: null,
        },
        select: { externalAccountId: true },
        orderBy: { updatedAt: 'desc' },
      });
      const larkIdentity = larkConnection?.externalAccountId
        ? await this.prisma.channelIdentity.findFirst({
            where: {
              companyId: String(runContext.companyId),
              channel: 'lark',
              larkOpenId: larkConnection.externalAccountId,
            },
            select: { id: true },
          })
        : null;
      if (!larkIdentity) {
        throw new ScheduledWorkflowControlError(
          'unavailable',
          'Connect your Lark account before scheduling delivery to your Lark DM.',
        );
      }
    }

    const config = buildScheduleConfig(input);
    const nextRunAt = getNextScheduledRunAt(config, this.clock.now());
    if (!nextRunAt) {
      throw new ScheduledWorkflowControlError(
        'bad_args',
        'This schedule has no future run time. Check the date, time, and timezone.',
      );
    }

    const workflow = await this.prisma.scheduledWorkflow.create({
      data: {
        companyId: String(runContext.companyId),
        ...(runContext.departmentId ? { departmentId: String(runContext.departmentId) } : {}),
        createdByUserId: String(runContext.userId),
        name: input.name.trim(),
        userIntent: input.intent.trim(),
        compiledPrompt: input.intent.trim(),
        scheduleType: input.scheduleType,
        scheduleConfigJson: config,
        timezone: input.timezone,
        workflowSpecJson: {},
        capabilitySummaryJson: {},
        outputConfigJson: { deliveryChannel: 'lark', deliveryTarget: 'creator_dm' },
        status: 'scheduled_active',
        scheduleEnabled: true,
        nextRunAt,
        originChatId: null,
      },
      select: scheduledWorkflowSummarySelect,
    });

    return {
      schedule: toSummary(workflow),
      nextRunLabel: formatScheduledSlot(nextRunAt, config.timezone),
    };
  }

  async list(
    runContext: RunContext,
    includeInactive = false,
  ): Promise<readonly ScheduledWorkflowSummary[]> {
    const statuses = (includeInactive
      ? ['scheduled_active', 'paused', 'archived']
      : ['scheduled_active']) as ScheduledWorkflowStatus[];
    const rows = await this.prisma.scheduledWorkflow.findMany({
      where: {
        companyId: String(runContext.companyId),
        createdByUserId: String(runContext.userId),
        status: { in: statuses },
      },
      orderBy: { createdAt: 'desc' },
      take: 25,
      select: scheduledWorkflowSummarySelect,
    });
    return rows.map(toSummary);
  }

  async pause(runContext: RunContext, scheduleId: string): Promise<ScheduledWorkflowSummary> {
    const workflow = await this.findOwned(runContext, scheduleId);
    if (workflow.status === 'archived') {
      throw new ScheduledWorkflowControlError('bad_args', `Schedule "${workflow.name}" is archived and cannot be paused.`);
    }
    const updated = await this.prisma.scheduledWorkflow.update({
      where: { id: workflow.id },
      data: { status: 'paused', scheduleEnabled: false, pausedAt: this.clock.now() },
      select: scheduledWorkflowSummarySelect,
    });
    return toSummary(updated);
  }

  async resume(runContext: RunContext, scheduleId: string): Promise<ScheduledWorkflowSummary> {
    const workflow = await this.findOwned(runContext, scheduleId);
    if (workflow.status === 'archived') {
      throw new ScheduledWorkflowControlError('bad_args', `Schedule "${workflow.name}" is archived and cannot be resumed.`);
    }
    const config = parseStoredConfig(workflow.scheduleConfigJson);
    const nextRunAt = getNextScheduledRunAt(config, this.clock.now());
    if (!nextRunAt) {
      throw new ScheduledWorkflowControlError('bad_args', 'This schedule has no future run time and cannot be resumed.');
    }
    const updated = await this.prisma.scheduledWorkflow.update({
      where: { id: workflow.id },
      data: {
        status: 'scheduled_active',
        scheduleEnabled: true,
        pausedAt: null,
        archivedAt: null,
        nextRunAt,
      },
      select: scheduledWorkflowSummarySelect,
    });
    return toSummary(updated);
  }

  async cancel(runContext: RunContext, scheduleId: string): Promise<ScheduledWorkflowSummary> {
    const workflow = await this.findOwned(runContext, scheduleId);
    const updated = await this.prisma.scheduledWorkflow.update({
      where: { id: workflow.id },
      data: {
        status: 'archived',
        scheduleEnabled: false,
        archivedAt: this.clock.now(),
        nextRunAt: null,
      },
      select: scheduledWorkflowSummarySelect,
    });
    return toSummary(updated);
  }

  async runNow(runContext: RunContext, scheduleId: string): Promise<ScheduledWorkflowSummary> {
    const workflow = await this.findOwned(runContext, scheduleId);
    if (workflow.status === 'archived') {
      throw new ScheduledWorkflowControlError('bad_args', `Schedule "${workflow.name}" is archived and cannot be run.`);
    }
    const updated = await this.prisma.scheduledWorkflow.update({
      where: { id: workflow.id },
      data: {
        nextRunAt: this.clock.now(),
        scheduleEnabled: true,
        status: 'scheduled_active',
        pausedAt: null,
      },
      select: scheduledWorkflowSummarySelect,
    });
    return toSummary(updated);
  }

  private async findOwned(runContext: RunContext, scheduleId: string) {
    const workflow = await this.prisma.scheduledWorkflow.findFirst({
      where: {
        id: scheduleId,
        companyId: String(runContext.companyId),
        createdByUserId: String(runContext.userId),
      },
      select: {
        ...scheduledWorkflowSummarySelect,
        scheduleConfigJson: true,
      },
    });
    if (!workflow) {
      throw new ScheduledWorkflowControlError('not_found', `Schedule ${scheduleId} was not found.`);
    }
    return workflow;
  }
}

function buildScheduleConfig(input: ScheduleCreateInput): ScheduleConfig {
  switch (input.scheduleType) {
    case 'one_time':
      if (!input.runAt) {
        throw new ScheduledWorkflowControlError('bad_args', 'runAt is required for a one-time schedule.');
      }
      return { type: 'one_time', timezone: input.timezone, runAt: input.runAt };
    case 'hourly':
      return {
        type: 'hourly',
        timezone: input.timezone,
        intervalHours: input.intervalHours ?? 1,
        minute: input.minute ?? 0,
      };
    case 'daily':
      return {
        type: 'daily',
        timezone: input.timezone,
        time: { hour: input.hour ?? 9, minute: input.timeMinute ?? 0 },
      };
    case 'weekly':
      return {
        type: 'weekly',
        timezone: input.timezone,
        daysOfWeek: (input.daysOfWeek ?? ['MO']) as Extract<ScheduleConfig, { type: 'weekly' }>['daysOfWeek'],
        time: { hour: input.hour ?? 9, minute: input.timeMinute ?? 0 },
      };
    case 'monthly':
      return {
        type: 'monthly',
        timezone: input.timezone,
        dayOfMonth: input.dayOfMonth ?? 1,
        time: { hour: input.hour ?? 9, minute: input.timeMinute ?? 0 },
      };
  }
}

function parseStoredConfig(value: unknown): ScheduleConfig {
  const parsed = scheduleConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new ScheduledWorkflowControlError('bad_args', 'The stored schedule configuration is invalid.');
  }
  return parsed.data;
}

const scheduledWorkflowSummarySelect = {
  id: true,
  name: true,
  scheduleType: true,
  status: true,
  timezone: true,
  nextRunAt: true,
  lastRunAt: true,
} as const;

function toSummary(row: {
  id: string;
  name: string;
  scheduleType: string;
  status: string;
  timezone: string;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
}): ScheduledWorkflowSummary {
  return {
    id: row.id,
    name: row.name,
    scheduleType: row.scheduleType,
    status: row.status,
    timezone: row.timezone,
    nextRunAt: row.nextRunAt?.toISOString() ?? null,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    // Stated rather than read back from the row. Schedules created before this
    // rule still carry `origin_chat`, and often a desktop channel, but the
    // runtime now delivers every one of them to the creator's Lark DM. Echoing
    // the stored config would describe a delivery that can no longer happen.
    deliveryChannel: 'lark',
    deliveryTarget: 'creator_dm',
  };
}
