import { dynamicTool } from 'ai';
import { z } from 'zod';
import type { PrismaClient } from '../../../../generated/prisma';
import type { RunContext } from '../../../../domain/orchestration/run-context';

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
      const args = input as { includeArchived?: boolean };
      const statuses = (args.includeArchived
        ? ['scheduled_active', 'paused', 'archived']
        : ['scheduled_active']) as import('../../../../generated/prisma').ScheduledWorkflowStatus[];

      const rows = await prisma.scheduledWorkflow.findMany({
        where: {
          companyId:       String(runContext.companyId),
          createdByUserId: String(runContext.userId),
          status:          { in: statuses },
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true, name: true, scheduleType: true, status: true, nextRunAt: true },
      });

      if (rows.length === 0) return 'No scheduled tasks found.';

      return rows
        .map(r => {
          const next = r.nextRunAt ? ` — next: ${r.nextRunAt.toISOString()}` : '';
          return `• [${r.status}] ${r.name} (${r.scheduleType})${next} (id:${r.id})`;
        })
        .join('\n');
    },
  });
}
