import { createTool } from '@mastra/core/tools';
import { randomUUID } from 'crypto';
import { z } from 'zod';

import { plannerAgent } from '../agents/planner.agent';
import { buildMastraAgentRunOptions } from '../mastra-model-control';
import { TOOL_REGISTRY_MAP } from '../../../tools/tool-registry';
import { emitActivityEvent } from './activity-bus';
import { emitPlanEvent } from './plan-bus';
import {
  buildDesktopPlannerPrompt,
  formatExecutionPlanForLog,
  initializeExecutionPlan,
  plannerDraftSchema,
} from '../../../../modules/desktop-chat/desktop-plan';

const TOOL_ID = 'planner-agent';

export const plannerAgentTool = createTool({
  id: TOOL_ID,
  description:
    'Create a structured execution plan for complex multi-step or cross-domain requests before other specialists are used.',
  inputSchema: z.object({
    query: z.string().describe('The user objective that may need a structured execution plan.'),
  }),
  execute: async (inputData, context) => {
    const requestContext = context?.requestContext;
    const allowedToolIds = requestContext?.get('allowedToolIds') as string[] | undefined;
    if (allowedToolIds !== undefined && !allowedToolIds.includes(TOOL_ID)) {
      const name = TOOL_REGISTRY_MAP.get(TOOL_ID)?.name ?? TOOL_ID;
      return { answer: `Access to "${name}" is not permitted for your role. Please contact your admin.` };
    }

    const requestId = requestContext?.get('requestId') as string | undefined;
    const workspaceName = requestContext?.get('workspaceName') as string | undefined;
    const workspacePath = requestContext?.get('workspacePath') as string | undefined;
    const callId = randomUUID();

    if (requestId) {
      emitActivityEvent(requestId, 'activity', {
        id: callId,
        name: TOOL_ID,
        label: 'Planning the task',
        icon: 'list-todo',
      });
    }

    const runOptions = await buildMastraAgentRunOptions('mastra.planner', { requestContext });
    const result = await plannerAgent.generate(
      buildDesktopPlannerPrompt({
        message: inputData.query,
        workspace: workspaceName && workspacePath ? { name: workspaceName, path: workspacePath } : null,
      }),
      runOptions as any,
    );

    const plannerText = typeof result?.text === 'string' ? result.text.trim() : '';
    const draft = plannerDraftSchema.parse(JSON.parse(plannerText));
    const plan = initializeExecutionPlan(draft);

    if (requestId) {
      emitPlanEvent(requestId, plan);
      emitActivityEvent(requestId, 'activity_done', {
        id: callId,
        name: TOOL_ID,
        label: 'Planned the task',
        icon: 'list-todo',
        resultSummary: formatExecutionPlanForLog(plan),
      });
    }

    return {
      answer: `Execution plan ready for goal: ${plan.goal}`,
      plan,
    };
  },
});
