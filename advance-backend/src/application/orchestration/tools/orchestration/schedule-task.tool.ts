import { dynamicTool } from 'ai';
import { z } from 'zod';
import type { PrismaClient } from '../../../../generated/prisma';
import type { RunContext } from '../../../../domain/orchestration/run-context';
import type { ScheduleConfig } from '../../../scheduling/schedule-config';
import { getNextScheduledRunAt, formatScheduledSlot } from '../../../scheduling/schedule-calculator';

const schema = z.object({
  name: z.string().describe('Short display name for the scheduled task'),
  intent: z.string().describe('Natural-language description of what should happen when this runs'),
  scheduleType: z.enum(['one_time', 'hourly', 'daily', 'weekly', 'monthly']).describe('Recurrence type'),
  timezone: z.string().default('Asia/Kolkata').describe('IANA timezone (default: Asia/Kolkata)'),
  runAt: z.string().optional().describe('ISO 8601 datetime for one_time schedules'),
  intervalHours: z.number().int().min(1).max(24).optional().describe('For hourly: run every N hours'),
  minute: z.number().int().min(0).max(59).optional().describe('For hourly: minute of the hour (default 0)'),
  hour: z.number().int().min(0).max(23).optional().describe('Hour of day (0-23) for daily/weekly/monthly'),
  timeMinute: z.number().int().min(0).max(59).optional().describe('Minute of hour (0-59) for daily/weekly/monthly'),
  daysOfWeek: z.array(z.string()).optional().describe('For weekly: days like ["MO","WE","FR"]'),
  dayOfMonth: z.number().int().min(1).max(31).optional().describe('For monthly: day of month (1-31)'),
});

function buildConfig(args: z.infer<typeof schema>): ScheduleConfig {
  switch (args.scheduleType) {
    case 'one_time':
      return { type: 'one_time', timezone: args.timezone, runAt: args.runAt! };
    case 'hourly':
      return { type: 'hourly', timezone: args.timezone, intervalHours: args.intervalHours ?? 1, minute: args.minute ?? 0 };
    case 'daily':
      return { type: 'daily', timezone: args.timezone, time: { hour: args.hour ?? 9, minute: args.timeMinute ?? 0 } };
    case 'weekly':
      return { type: 'weekly', timezone: args.timezone, daysOfWeek: (args.daysOfWeek ?? ['MO']) as ScheduleConfig & { type: 'weekly' } extends { daysOfWeek: infer D } ? D : never, time: { hour: args.hour ?? 9, minute: args.timeMinute ?? 0 } };
    case 'monthly':
      return { type: 'monthly', timezone: args.timezone, dayOfMonth: args.dayOfMonth ?? 1, time: { hour: args.hour ?? 9, minute: args.timeMinute ?? 0 } };
  }
}

export function createScheduleTaskTool(
  prisma: PrismaClient,
  runContext: RunContext,
) {
  return dynamicTool({
    description:
      'Create a recurring or one-time scheduled task. Use for "remind me every Monday", "send daily report at 9am", "check invoices on the 1st of each month", etc.',
    inputSchema: schema as never,
    execute: async (input: unknown): Promise<string> => {
      const args = schema.parse(input);

      if (args.scheduleType === 'one_time' && !args.runAt) {
        return 'Error: runAt is required for one_time schedules (ISO 8601 datetime).';
      }

      const config = buildConfig(args);
      const nextRunAt = getNextScheduledRunAt(config);

      if (!nextRunAt) {
        return 'Error: this schedule has no future run time. Check the date/time.';
      }

      const workflow = await prisma.scheduledWorkflow.create({
        data: {
          companyId:             String(runContext.companyId),
          createdByUserId:       String(runContext.userId),
          name:                  args.name,
          userIntent:            args.intent,
          compiledPrompt:        args.intent,
          scheduleType:          args.scheduleType,
          scheduleConfigJson:    config,
          timezone:              args.timezone,
          workflowSpecJson:      {},
          capabilitySummaryJson: {},
          outputConfigJson:      {},
          status:                'scheduled_active',
          scheduleEnabled:       true,
          nextRunAt,
          originChatId:          runContext.chatId ?? null,
        },
        select: { id: true, name: true },
      });

      const when = formatScheduledSlot(nextRunAt, config.timezone);
      return `Scheduled "${workflow.name}" — next run: ${when} (id:${workflow.id})`;
    },
  });
}
