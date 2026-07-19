import { dynamicTool } from 'ai';
import { z } from 'zod';
import type { PrismaClient } from '../../../../generated/prisma';
import type { RunContext } from '../../../../domain/orchestration/run-context';
import { ScheduledWorkflowControlService } from '../../../scheduling/scheduled-workflow-control.service';

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
      try {
        const service = new ScheduledWorkflowControlService(prisma);
        const workflow = args.action === 'cancel'
          ? await service.cancel(runContext, args.id)
          : await service.pause(runContext, args.id);
        const verb = args.action === 'cancel' ? 'Cancelled' : 'Paused';
        return `${verb} "${workflow.name}" (id:${workflow.id})`;
      } catch (error) {
        return `error: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });
}
