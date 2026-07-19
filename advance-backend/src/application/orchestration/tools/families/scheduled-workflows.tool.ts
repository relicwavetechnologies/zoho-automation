import { z } from 'zod';
import type { PrismaClient } from '../../../../generated/prisma';
import type { Tool, ToolExecutionContext } from '../tool.contract';
import type { Result } from '../../../../shared/result';
import { err, ok } from '../../../../shared/result';
import { PermissionError, ToolError } from '../../../../shared/errors';
import type { PermissionResult } from '../../../permissions/permission.types';
import type { ToolActionGroup } from '../../../../domain/permissions/tool-action-group';
import { asToolId } from '../../../../shared/ids';
import {
  ScheduledWorkflowControlError,
  ScheduledWorkflowControlService,
} from '../../../scheduling/scheduled-workflow-control.service';

const createBaseFields = {
  name: z.string().trim().min(1).max(120).describe('Short display name for the scheduled work.'),
  intent: z.string().trim().min(1).max(10_000).describe('Complete self-contained instructions for what Divo should do on every run.'),
  timezone: z.string().trim().min(1).max(100).describe('IANA timezone.'),
} as const;

export const scheduledWorkflowsArgsSchema = z.union([
  z.object({
    operation: z.literal('create'),
    ...createBaseFields,
    scheduleType: z.literal('one_time'),
    runAt: z.string().datetime({ offset: true }).describe('Future timezone-aware ISO 8601 date-time.'),
  }).strict(),
  z.object({
    operation: z.literal('create'),
    ...createBaseFields,
    scheduleType: z.literal('hourly'),
    intervalHours: z.number().int().min(1).max(24),
    minute: z.number().int().min(0).max(59).describe('Minute of each hour.'),
  }).strict(),
  z.object({
    operation: z.literal('create'),
    ...createBaseFields,
    scheduleType: z.literal('daily'),
    hour: z.number().int().min(0).max(23),
    timeMinute: z.number().int().min(0).max(59),
  }).strict(),
  z.object({
    operation: z.literal('create'),
    ...createBaseFields,
    scheduleType: z.literal('weekly'),
    daysOfWeek: z.array(z.enum(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'])).min(1).max(7),
    hour: z.number().int().min(0).max(23),
    timeMinute: z.number().int().min(0).max(59),
  }).strict(),
  z.object({
    operation: z.literal('create'),
    ...createBaseFields,
    scheduleType: z.literal('monthly'),
    dayOfMonth: z.number().int().min(1).max(31),
    hour: z.number().int().min(0).max(23),
    timeMinute: z.number().int().min(0).max(59),
  }).strict(),
  z.object({ operation: z.literal('list'), includeInactive: z.boolean().optional() }).strict(),
  z.object({ operation: z.literal('pause'), scheduleId: z.string().uuid() }).strict(),
  z.object({ operation: z.literal('resume'), scheduleId: z.string().uuid() }).strict(),
  z.object({ operation: z.literal('cancel'), scheduleId: z.string().uuid() }).strict(),
  z.object({ operation: z.literal('run_now'), scheduleId: z.string().uuid() }).strict(),
]);

type Args = z.infer<typeof scheduledWorkflowsArgsSchema>;

const scheduleSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  scheduleType: z.string(),
  status: z.string(),
  timezone: z.string(),
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  deliveryChannel: z.enum(['lark', 'desktop']),
});

const ResultSchema = z.object({
  operation: z.enum(['create', 'list', 'pause', 'resume', 'cancel', 'run_now']),
  schedule: scheduleSummarySchema.optional(),
  schedules: z.array(scheduleSummarySchema).optional(),
  nextRunLabel: z.string().optional(),
});

type Res = z.infer<typeof ResultSchema>;

const actionFor = (operation: Args['operation']): ToolActionGroup => {
  switch (operation) {
    case 'list': return 'read';
    case 'create': return 'create';
    case 'pause':
    case 'resume': return 'update';
    case 'cancel': return 'delete';
    case 'run_now': return 'execute';
  }
};

export const createScheduledWorkflowsTool = (deps: {
  prisma: PrismaClient;
}): Tool<Args, Res> => ({
  id: asToolId('scheduledWorkflows'),
  family: 'scheduling',
  actionGroups: new Set(['read', 'create', 'update', 'delete', 'execute']),
  argsSchema: scheduledWorkflowsArgsSchema,
  resultSchema: ResultSchema,
  description:
    'Create and manage durable one-time or recurring Divo work. Results return to the conversation where the schedule was created.',
  parameterDocs: [
    'Gateway discovery: call work.resolve for the user request, then tools.list with { "toolId": "scheduledWorkflows" } before the first invocation.',
    'Gateway invocation: tools.invoke payload must be { "toolId": "scheduledWorkflows", "args": { ... } }. Keep operation and all schedule fields inside args.',
    'operation:',
    '- create: activate a one-time, hourly, daily, weekly, or monthly schedule.',
    '- list: list the current user\'s schedules; includeInactive=true also returns paused and archived schedules.',
    '- pause/resume/cancel/run_now: manage an existing schedule using scheduleId returned by create or list.',
    'create always requires name, intent, scheduleType, and timezone. intent must be self-contained: include the task, source/account, time window, filters, required skill/tool behavior, output, delivery expectation, external-action boundary, missing-data behavior, and failure behavior needed on every run.',
    'For one_time provide runAt as timezone-aware ISO 8601. For hourly provide intervalHours and minute. For daily provide hour and timeMinute. For weekly also provide daysOfWeek. For monthly also provide dayOfMonth.',
    'Exact timing shapes: one_time={runAt}; hourly={intervalHours,minute}; daily={hour,timeMinute}; weekly={daysOfWeek,hour,timeMinute}; monthly={dayOfMonth,hour,timeMinute}. Do not mix timing fields between variants.',
    'Calendar boundary: use this tool for Divo work that runs later or repeatedly. Use a calendar tool for meetings, attendee invitations, free/busy checks, or reserving time.',
    'Never guess a material time, timezone, monitoring scope, external-action boundary, or failure behavior. Ask the user when one is unclear.',
    'Completion: do not claim scheduled until create returns a schedule id, status, and next run. approval_required means pending, not complete.',
  ].join('\n'),

  permissionCheck(args: Args, perm: PermissionResult): Result<ToolActionGroup, PermissionError> {
    const action = actionFor(args.operation);
    if (perm.allowedActionsByTool.get(asToolId('scheduledWorkflows'))?.has(action)) {
      return ok(action);
    }
    return err(new PermissionError({
      toolId: 'scheduledWorkflows',
      action,
      reason: 'not_allowed',
      message: `Scheduled work is not allowed for the ${action} action in this department.`,
    }));
  },

  async execute(args: Args, ctx: ToolExecutionContext): Promise<Result<Res, ToolError>> {
    const service = new ScheduledWorkflowControlService(deps.prisma, ctx.clock);
    try {
      switch (args.operation) {
        case 'create': {
          const created = await service.create(ctx.runContext, args);
          return ok({ operation: 'create', ...created });
        }
        case 'list':
          return ok({ operation: 'list', schedules: [...await service.list(ctx.runContext, args.includeInactive ?? false)] });
        case 'pause':
          return ok({ operation: 'pause', schedule: await service.pause(ctx.runContext, args.scheduleId) });
        case 'resume':
          return ok({ operation: 'resume', schedule: await service.resume(ctx.runContext, args.scheduleId) });
        case 'cancel':
          return ok({ operation: 'cancel', schedule: await service.cancel(ctx.runContext, args.scheduleId) });
        case 'run_now':
          return ok({ operation: 'run_now', schedule: await service.runNow(ctx.runContext, args.scheduleId) });
      }
    } catch (error) {
      const known = error instanceof ScheduledWorkflowControlError;
      return err(new ToolError({
        toolId: 'scheduledWorkflows',
        reason: known && error.reason === 'bad_args' ? 'bad_args' : 'upstream_failure',
        cause: error,
        message: error instanceof Error ? error.message : String(error),
      }));
    }
  },
});
