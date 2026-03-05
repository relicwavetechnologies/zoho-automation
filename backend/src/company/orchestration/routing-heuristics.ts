import type { AgentResultDTO, NormalizedIncomingMessageDTO, OrchestrationTaskDTO } from '../contracts';

export const WRITE_INTENT_KEYWORDS = ['delete', 'remove', 'drop', 'overwrite', 'destroy', 'write'];

export const classifyComplexityLevel = (text: string): 1 | 2 | 3 | 4 | 5 => {
  const normalized = text.toLowerCase();
  if (WRITE_INTENT_KEYWORDS.some((keyword) => normalized.includes(keyword))) {
    return 4;
  }
  if (normalized.includes('sync') || normalized.includes('onboard') || normalized.includes('workflow')) {
    return 3;
  }
  if (normalized.trim().length <= 40) {
    return 1;
  }
  return 2;
};

export const detectRouteIntent = (text: string): 'zoho_read' | 'write_intent' | 'general' => {
  const normalized = text.toLowerCase();
  if (normalized.includes('zoho') || normalized.includes('deal') || normalized.includes('contact')) {
    return 'zoho_read';
  }
  if (WRITE_INTENT_KEYWORDS.some((keyword) => normalized.includes(keyword))) {
    return 'write_intent';
  }
  return 'general';
};

export const buildPlanFromIntent = (
  intent: 'zoho_read' | 'write_intent' | 'general',
  complexityLevel: 1 | 2 | 3 | 4 | 5,
  text: string,
): string[] => {
  const normalized = text.toLowerCase();

  if (intent === 'zoho_read') {
    return ['route.classify', 'agent.invoke.zoho-read', 'agent.invoke.lark-response', 'synthesis.compose'];
  }

  if (normalized.includes('unknown_agent')) {
    return ['route.classify', 'agent.invoke.unknown', 'synthesis.compose'];
  }

  if (intent === 'write_intent' || complexityLevel >= 4) {
    return [
      'route.classify',
      'agent.invoke.risk-check',
      'agent.invoke.response',
      'agent.invoke.lark-response',
      'synthesis.compose',
    ];
  }

  return ['route.classify', 'agent.invoke.response', 'agent.invoke.lark-response', 'synthesis.compose'];
};

export const requiresHumanConfirmation = (text: string): boolean => {
  const normalized = text.toLowerCase();
  return WRITE_INTENT_KEYWORDS.some((keyword) => normalized.includes(keyword));
};

export const buildHitlSummary = (text: string): string => {
  const summary = text.trim();
  if (summary.length <= 160) {
    return summary;
  }
  return `${summary.slice(0, 157)}...`;
};

export const synthesizeFromAgentResults = (
  task: OrchestrationTaskDTO,
  message: NormalizedIncomingMessageDTO,
  agentResults: AgentResultDTO[],
): { taskStatus: 'done' | 'failed'; text: string } => {
  const failed = agentResults.find((result) => result.status === 'failed');
  if (failed) {
    return {
      taskStatus: 'failed',
      text: `Request could not be completed: ${failed.message}`,
    };
  }

  const zohoResult = agentResults.find((result) => result.agentKey === 'zoho-read' && result.status === 'success');
  if (zohoResult?.result) {
    const sources = Array.isArray(zohoResult.result.sources)
      ? (zohoResult.result.sources as string[]).slice(0, 3)
      : [];
    const sourceText = sources.length > 0 ? ` Sources: ${sources.join(', ')}.` : '';
    return {
      taskStatus: 'done',
      text: `Zoho data read complete.${sourceText}`,
    };
  }

  return {
    taskStatus: 'done',
    text: `Processed (${task.executionMode}) for message ${message.messageId}. Plan: ${task.plan.join(' -> ')}`,
  };
};
