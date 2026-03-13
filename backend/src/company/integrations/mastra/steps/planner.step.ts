import { createStep } from '@mastra/core/workflows';
import { z } from 'zod';

import { PLAN_OWNER_AGENTS } from '../../../../modules/desktop-chat/desktop-plan';
import { plannerAgent } from '../agents/planner.agent';
import { buildMastraAgentRunOptions } from '../mastra-model-control';

export const taskSchema = z.object({
  taskId: z.string(),
  title: z.string(),
  ownerAgent: z.enum(PLAN_OWNER_AGENTS),
  dependsOn: z.array(z.string()).default([]),
  isWriteOperation: z.boolean(),
  successCriteria: z.string(),
});

export const executionPlanSchema = z.object({
  goal: z.string(),
  tasks: z.array(taskSchema),
  estimatedComplexity: z.enum(['simple', 'multi-step', 'cross-domain']),
});

export const plannerStep = createStep({
  id: 'planner-step',
  inputSchema: z.object({
    userObjective: z.string(),
    requestContext: z.object({
      userId: z.string(),
      permissions: z.array(z.string()),
    }),
    failureContext: z.string().optional(),
  }),
  outputSchema: executionPlanSchema,
  execute: async ({ inputData, requestContext }) => {
    const prompt = inputData.failureContext
      ? `${inputData.userObjective}\n\nPrevious attempt failed: ${inputData.failureContext}. Revise the plan accordingly.`
      : inputData.userObjective;

    const runOptions = await buildMastraAgentRunOptions('mastra.planner', { requestContext });
    const result = await plannerAgent.generate(
      [{ role: 'user', content: prompt }],
      {
        ...(runOptions as any),
        structuredOutput: {
          schema: executionPlanSchema,
        },
      },
    );

    return executionPlanSchema.parse(result.object);
  },
});
