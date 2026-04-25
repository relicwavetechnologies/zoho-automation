/**
 * runScheduledNow — triggers an existing scheduled workflow immediately.
 * Sets nextRunAt to now, which the scheduler will pick up on its next poll.
 */

import { dynamicTool } from 'ai';
import { z } from 'zod';
import type { PrismaClient } from '../../../../generated/prisma';
import type { RunContext } from '../../../../domain/orchestration/run-context';

const schema = z.object({
  id: z.string().describe('The schedule ID to run immediately'),
});

export function createRunScheduledNowTool(
  prisma: PrismaClient,
  runContext: RunContext,
) {
  return dynamicTool({
    description:
      'Trigger an existing scheduled task to run right now (one-off immediate execution).',
    inputSchema: schema as never,
    execute: async (input: unknown): Promise<string> => {
      const args = input as { id: string };
      const workflow = await prisma.scheduledWorkflow.findFirst({
        where: {
          id:              args.id,
          companyId:       String(runContext.companyId),
          createdByUserId: String(runContext.userId),
        },
        select: { id: true, name: true, status: true },
      });

      if (!workflow) return `error: schedule ${args.id} not found`;
      if (workflow.status === 'archived') return `error: "${workflow.name}" is archived and cannot be run`;

      await prisma.scheduledWorkflow.update({
        where: { id: args.id },
        data: {
          nextRunAt:       new Date(),
          scheduleEnabled: true,
          status:          'scheduled_active',
        },
      });

      return `Triggered "${workflow.name}" to run now — it will execute on the next scheduler cycle.`;
    },
  });
}
