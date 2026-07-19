import { dynamicTool } from 'ai';
import { z } from 'zod';
import type { PrismaClient } from '../../../../generated/prisma';
import type { RunContext } from '../../../../domain/orchestration/run-context';
import { ScheduledWorkflowControlService } from '../../../scheduling/scheduled-workflow-control.service';

const schema = z.object({
  includeArchived: z.boolean().optional().default(false).describe(
    'Include paused or archived schedules (default: false)',
  ),
});

export function createListScheduledTasksTool(
  prisma: PrismaClient,
  runContext: RunContext,
) {
  return dynamicTool({
    description: "List the user's scheduled tasks.",
    inputSchema: schema as never,
    execute: async (input: unknown): Promise<string> => {
      const args = schema.parse(input);
      const rows = await new ScheduledWorkflowControlService(prisma).list(runContext, args.includeArchived);

      if (rows.length === 0) return 'No scheduled tasks found.';

      return rows
        .map(r => {
          const next = r.nextRunAt ? ` — next: ${r.nextRunAt}` : '';
          return `• [${r.status}] ${r.name} (${r.scheduleType})${next} (id:${r.id})`;
        })
        .join('\n');
    },
  });
}
