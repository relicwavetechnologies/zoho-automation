import test from 'node:test';
import assert from 'node:assert/strict';

import {
  executeSupervisorPlan,
  type DelegatedAgentExecutionResult,
  type SupervisorPlan,
} from '../src/company/orchestration/supervisor';

test('executeSupervisorPlan runs dependency-free steps before dependents and merges task state per wave', async () => {
  const order: string[] = [];
  const plan: SupervisorPlan = {
    complexity: 'multi',
    steps: [
      {
        stepId: 's1',
        agentId: 'zoho-ops-agent',
        objective: 'fetch invoices',
        dependsOn: [],
        inputRefs: [],
      },
      {
        stepId: 's2',
        agentId: 'context-agent',
        objective: 'resolve recipient',
        dependsOn: [],
        inputRefs: [],
      },
      {
        stepId: 's3',
        agentId: 'google-workspace-agent',
        objective: 'send email',
        dependsOn: ['s1', 's2'],
        inputRefs: ['s1', 's2'],
      },
    ],
  };

  const result = await executeSupervisorPlan({
    plan,
    originalUserMessage: 'email the invoices to Archit sir',
    initialTaskState: { completed: [] as string[] },
    buildScopedContext: () => [],
    mergeTaskState: (state, stepResult) => ({
      completed: [...state.completed, stepResult.stepId],
    }),
    executeStep: async ({ step, taskState, dependencyInputs }) => {
      order.push(`${step.stepId}:${taskState.completed.join(',')}`);
      return {
        stepId: step.stepId,
        agentId: step.agentId,
        objective: step.objective,
        status: 'success',
        summary: step.objective,
        assistantText: step.objective,
        text: step.objective,
        data: {
          dependencyStepIds: dependencyInputs.map((entry) => entry.stepId),
        },
        taskState,
      } satisfies DelegatedAgentExecutionResult<{ completed: string[] }>;
    },
  });

  assert.deepEqual(order.slice(0, 2).sort(), ['s1:', 's2:']);
  assert.equal(order[2], 's3:s1,s2');
  assert.equal(result.waveCount, 2);
  assert.deepEqual(result.finalTaskState.completed, ['s1', 's2', 's3']);
  assert.deepEqual(result.results[2]?.data?.dependencyStepIds, ['s1', 's2']);
});
