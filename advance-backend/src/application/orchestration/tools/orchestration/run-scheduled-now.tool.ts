/**
 * runScheduledNow — triggers an existing scheduled workflow immediately.
 * Sets nextRunAt to now, which the scheduler will pick up on its next poll.
 */

import { dynamicTool } from 'ai';
import { z } from 'zod';
import type { PrismaClient } from '../../../../generated/prisma';
import type { RunContext } from '../../../../domain/orchestration/run-context';
import { ScheduledWorkflowControlService } from '../../../scheduling/scheduled-workflow-control.service';

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
      try {
        const workflow = await new ScheduledWorkflowControlService(prisma).runNow(runContext, args.id);
        return `Triggered "${workflow.name}" to run now — it will execute on the next scheduler cycle.`;
      } catch (error) {
        return `error: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });
}
