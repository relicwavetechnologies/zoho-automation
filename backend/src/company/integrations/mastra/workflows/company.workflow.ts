import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

import { logger } from '../../../../utils/logger';
import { executionStep, executionStepOutputSchema } from '../steps/execution.step';
import { outcomeVerifierStep } from '../steps/outcome-verifier.step';
import { executionPlanSchema, plannerStep } from '../steps/planner.step';

const requestContextSchema = z.object({
  userId: z.string(),
  permissions: z.array(z.string()),
});

const workflowAgentIdSchema = z.enum([
  'supervisorAgent',
  'zohoAgent',
  'outreachAgent',
  'searchAgent',
  'larkBaseAgent',
  'larkTaskAgent',
  'larkCalendarAgent',
  'larkMeetingAgent',
  'larkApprovalAgent',
  'larkDocAgent',
]);

const workflowOutputSchema = z.object({
  finalAnswer: z.string(),
  planStatus: z.enum(['completed', 'failed', 'partial']),
  executionPath: z.array(z.string()),
});

const buildVerificationFailureMessage = (input: {
  blockers: string[];
  reasons: string[];
}): string => {
  const blockerLine = input.blockers.length > 0
    ? `I couldn't verify the completed write operations for task IDs: ${input.blockers.join(', ')}.`
    : 'I could not verify the completed write operations.';
  const reasonLine = input.reasons.length > 0
    ? ` ${input.reasons.join(' ')}`
    : '';
  return `${blockerLine}${reasonLine}`.trim();
};

const buildPartialVerificationMessage = (input: {
  finalAnswer: string;
  reasons: string[];
}): string => {
  const suffix = input.reasons.length > 0
    ? `\n\nVerification note: ${input.reasons.join(' ')}`
    : '';
  return `${input.finalAnswer}${suffix}`.trim();
};

const companyWorkflowResultStep = createStep({
  id: 'company-workflow-result',
  inputSchema: z.object({
    allVerified: z.boolean(),
    results: z.array(z.object({
      taskId: z.string(),
      verified: z.boolean(),
      confidence: z.enum(['high', 'low', 'unverifiable']),
      reason: z.string(),
    })),
    blockers: z.array(z.string()),
  }),
  outputSchema: workflowOutputSchema,
  execute: async ({ getStepResult, inputData }) => {
    const executionResult = getStepResult(executionStep) as z.infer<typeof executionStepOutputSchema>;
    const unverifiableReasons = inputData.results
      .filter((result) => !result.verified && result.confidence === 'unverifiable')
      .map((result) => result.reason);

    if (inputData.blockers.length > 0) {
      return {
        finalAnswer: buildVerificationFailureMessage({
          blockers: inputData.blockers,
          reasons: inputData.results
            .filter((result) => inputData.blockers.includes(result.taskId))
            .map((result) => result.reason),
        }),
        planStatus: 'failed' as const,
        executionPath: [...executionResult.executionPath, 'outcome-verifier', 'company-workflow-result'],
      };
    }

    const finalAnswer = executionResult.finalAnswer.trim()
      || executionResult.completedTasks.map((task) => task.claimed).filter(Boolean).join('\n');

    if (unverifiableReasons.length > 0) {
      return {
        finalAnswer: buildPartialVerificationMessage({
          finalAnswer: finalAnswer || 'The task completed, but I could not independently verify every write operation.',
          reasons: unverifiableReasons,
        }),
        planStatus: 'partial' as const,
        executionPath: [...executionResult.executionPath, 'outcome-verifier', 'company-workflow-result'],
      };
    }

    return {
      finalAnswer: finalAnswer || 'Task completed.',
      planStatus: 'completed' as const,
      executionPath: [...executionResult.executionPath, 'outcome-verifier', 'company-workflow-result'],
    };
  },
});

export const companyWorkflow = createWorkflow({
  id: 'company-orchestration',
  inputSchema: z.object({
    userObjective: z.string(),
    requestContext: requestContextSchema,
    attachmentContent: z.string().optional(),
    agentId: workflowAgentIdSchema.optional(),
    mode: z.enum(['fast', 'high', 'xtreme']).optional(),
    agentMessages: z.array(z.object({
      role: z.enum(['system', 'user', 'assistant']),
      content: z.any(),
    })).optional(),
  }),
  outputSchema: workflowOutputSchema,
  stateSchema: z.object({
    currentPlan: executionPlanSchema.nullable(),
    failedTasks: z.array(z.string()),
    completedTasks: z.array(z.string()),
    replanCount: z.number(),
  }),
  options: {
    onError: async (errorInfo) => {
      logger.error('company.workflow.error', {
        runId: errorInfo.runId,
        error: errorInfo.error instanceof Error ? errorInfo.error.message : 'unknown_workflow_error',
      });
    },
    onFinish: async (resultInfo) => {
      logger.info('company.workflow.finish', {
        runId: resultInfo.runId,
        status: resultInfo.status,
        stepExecutionPath: resultInfo.stepExecutionPath,
      });
    },
  },
})
  .then(plannerStep)
  .then(executionStep)
  .then(outcomeVerifierStep)
  .then(companyWorkflowResultStep)
  .commit();
