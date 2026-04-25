import { dynamicTool } from 'ai';
import { z } from 'zod';
import type { PrismaClient } from '../../../../generated/prisma';
import type { RunContext } from '../../../../domain/orchestration/run-context';

const schema = z.object({
  id: z.string().describe('The schedule ID to cancel or pause'),
  action: z.enum(['cancel', 'pause']).describe(
    'cancel=permanently archive it; pause=temporarily disable without deleting',
  ),
});

export function createCancelScheduledTaskTool(
  prisma: PrismaClient,
  runContext: RunContext,
) {
  return dynamicTool({
    description: 'Cancel or pause a scheduled task.',
    inputSchema: schema as never,
    execute: async (input: unknown): Promise<string> => {
      const args = input as { id: string; action: 'cancel' | 'pause' };
      const workflow = await prisma.scheduledWorkflow.findFirst({
        where: {
          id:              args.id,
          companyId:       String(runContext.companyId),
          createdByUserId: String(runContext.userId),
        },
        select: { id: true, name: true, status: true },
      });

      if (!workflow) return `error: schedule ${args.id} not found`;

      const newStatus = args.action === 'cancel' ? 'archived' : 'paused';
      const now = new Date();

      await prisma.scheduledWorkflow.update({
        where: { id: args.id },
        data: {
          status:          newStatus,
          scheduleEnabled: false,
          ...(args.action === 'cancel' ? { archivedAt: now } : { pausedAt: now }),
        },
      });

      const verb = args.action === 'cancel' ? 'Cancelled' : 'Paused';
      return `${verb} "${workflow.name}" (id:${workflow.id})`;
    },
  });
}
