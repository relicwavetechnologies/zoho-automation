import { dynamicTool } from 'ai';
import { z } from 'zod';
import type { PrismaClient } from '../../../../generated/prisma';
import type { RunContext } from '../../../../domain/orchestration/run-context';
import { ScheduledWorkflowControlService } from '../../../scheduling/scheduled-workflow-control.service';

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
      try {
        const created = await new ScheduledWorkflowControlService(prisma).create(runContext, args);
        return `Scheduled "${created.schedule.name}" — next run: ${created.nextRunLabel} (id:${created.schedule.id})`;
      } catch (error) {
        return `Error: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });
}
