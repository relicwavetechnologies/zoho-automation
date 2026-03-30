import { generateText } from 'ai';

import type { DelegatedStepResult, SupervisorPlan } from './types';

const buildSynthesisPrompt = (input: {
  latestUserMessage: string;
  plan: SupervisorPlan;
  stepResults: DelegatedStepResult[];
}): string =>
  JSON.stringify({
    latestUserMessage: input.latestUserMessage,
    plan: {
      complexity: input.plan.complexity,
      steps: input.plan.steps.map((step) => ({
        stepId: step.stepId,
        agentId: step.agentId,
        objective: step.objective,
        dependsOn: step.dependsOn,
        inputRefs: step.inputRefs,
      })),
    },
    stepResults: input.stepResults.map((result) => ({
      stepId: result.stepId,
      agentId: result.agentId,
      status: result.status,
      summary: result.summary,
      finalText: result.finalText,
      sourceRefs: result.sourceRefs ?? [],
      toolResults: result.toolEnvelopes.map((tool) => ({
        toolName: tool.toolName,
        summary: tool.output.summary,
        success: tool.output.success,
        confirmedAction: tool.output.confirmedAction,
        pendingApproval: Boolean(tool.output.pendingApprovalAction),
      })),
    })),
  });

export const synthesizeSupervisorResult = async (input: {
  model: any;
  providerOptions?: Record<string, unknown>;
  systemPrompt: string;
  latestUserMessage: string;
  plan: SupervisorPlan;
  stepResults: DelegatedStepResult[];
}): Promise<string> => {
  const result = await generateText({
    model: input.model,
    system: [
      input.systemPrompt,
      'You are synthesizing the final answer from delegated agent results.',
      'Do not mention internal orchestration unless it helps explain a failure or approval requirement.',
      'Use the delegated results as ground truth. Do not invent extra tool outcomes.',
    ].join('\n\n'),
    prompt: buildSynthesisPrompt({
      latestUserMessage: input.latestUserMessage,
      plan: input.plan,
      stepResults: input.stepResults,
    }),
    temperature: 0.2,
    providerOptions: input.providerOptions,
  });
  return result.text.trim();
};

export const runSupervisorSynthesis = synthesizeSupervisorResult;

export const chooseSupervisorPassThroughText = (input: {
  latestUserMessage: string;
  stepResult: {
    assistantText?: string;
    text?: string;
    summary?: string;
    pendingApproval?: unknown;
    blockingUserInput?: { userAction?: string; summary?: string } | null;
  };
}): string => {
  if (input.stepResult.pendingApproval) {
    return input.stepResult.assistantText?.trim()
      || input.stepResult.text?.trim()
      || 'Approval required before continuing.';
  }
  if (input.stepResult.blockingUserInput) {
    return input.stepResult.assistantText?.trim()
      || input.stepResult.blockingUserInput.userAction?.trim()
      || input.stepResult.blockingUserInput.summary?.trim()
      || 'I need one more detail before I can continue.';
  }
  return input.stepResult.assistantText?.trim()
    || input.stepResult.text?.trim()
    || input.stepResult.summary?.trim()
    || input.latestUserMessage.trim()
    || 'Done.';
};
