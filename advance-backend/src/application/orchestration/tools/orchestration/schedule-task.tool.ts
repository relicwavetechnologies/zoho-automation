/**
 * scheduleTask — supervisor tool to create a recurring or one-time scheduled task.
 * Backed by ScheduledWorkflow (reusing existing model).
 */

import { dynamicTool } from 'ai';
import { z } from 'zod';
import type { PrismaClient } from '../../../../generated/prisma';
import type { RunContext } from '../../../../domain/orchestration/run-context';

const schema = z.object({
  name: z.string().describe('Short display name for the scheduled task'),
  intent: z.string().describe('Natural-language description of what should happen when this runs'),
  scheduleType: z.enum(['one_time', 'daily', 'weekly', 'monthly']).describe(
    'Recurrence type',
  ),
  cronExpression: z.string().optional().describe(
    'Cron expression for weekly/monthly schedules (e.g. "0 9 * * 1" for Monday 9am). Required for weekly/monthly.',
  ),
  runAt: z.string().optional().describe(
    'ISO 8601 datetime for one_time or daily schedules (e.g. "2025-05-01T09:00:00+05:30")',
  ),
  timezone: z.string().optional().default('Asia/Kolkata').describe(
    'IANA timezone (default: Asia/Kolkata)',
  ),
});

export function createScheduleTaskTool(
  prisma: PrismaClient,
  runContext: RunContext,
) {
  return dynamicTool({
    description:
      'Create a recurring or one-time scheduled task. Use for "remind me every Monday", "send daily report at 9am", etc.',
    inputSchema: schema as never,
    execute: async (input: unknown): Promise<string> => {
      const args = input as {
        name:            string;
        intent:          string;
        scheduleType:    'one_time' | 'daily' | 'weekly' | 'monthly';
        cronExpression?: string;
        runAt?:          string;
        timezone?:       string;
      };
      const scheduleConfigJson = args.runAt
        ? { runAt: args.runAt }
        : args.cronExpression
          ? { cron: args.cronExpression }
          : {};

      const workflow = await prisma.scheduledWorkflow.create({
        data: {
          companyId:            String(runContext.companyId),
          createdByUserId:      String(runContext.userId),
          name:                 args.name,
          userIntent:           args.intent,
          compiledPrompt:       args.intent,
          scheduleType:         args.scheduleType,
          scheduleConfigJson,
          timezone:             args.timezone ?? 'Asia/Kolkata',
          workflowSpecJson:     {},
          capabilitySummaryJson: {},
          outputConfigJson:     {},
          status:               'scheduled_active',
          scheduleEnabled:      true,
          ...(args.runAt ? { nextRunAt: new Date(args.runAt) } : {}),
        },
        select: { id: true, name: true, scheduleType: true, nextRunAt: true },
      });

      const whenStr = workflow.nextRunAt
        ? `next run at ${workflow.nextRunAt.toISOString()}`
        : `schedule type: ${workflow.scheduleType}`;
      return `Scheduled "${workflow.name}" — ${whenStr} (id:${workflow.id})`;
    },
  });
}
