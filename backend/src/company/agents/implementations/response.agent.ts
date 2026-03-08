import type { AgentInvokeInputDTO } from '../../contracts';
import { BaseAgent } from '../base';

const isGreeting = (text: string): boolean =>
  /^(hi|hello|hey|yo|hola|namaste)\b/i.test(text.trim());

const isCapabilityQuestion = (text: string): boolean =>
  /\b(help|capabilities|what\s+can\s+you\s+do|what\s+things\s+you\s+can\s+do|how\s+can\s+you\s+help)\b/i.test(text);

const buildUserFacingReply = (objective: string): string => {
  if (isGreeting(objective)) {
    return 'Hi! How can I help with Zoho today?';
  }

  if (isCapabilityQuestion(objective)) {
    return 'I can help with Zoho CRM questions, outreach publisher lookup, web research, and creating Lark Docs from grounded results.';
  }

  return 'I can help with Zoho CRM tasks, outreach lookups, web research, and Lark Doc creation.';
};

export class ResponseAgent extends BaseAgent {
  readonly key = 'response';

  async invoke(input: AgentInvokeInputDTO) {
    const objective = input.objective.trim();
    if (objective.toLowerCase().includes('force_fail')) {
      return this.failure(
        input,
        'Response agent failed due to forced failure token',
        'forced_failure_token_detected',
      );
    }

    return this.success(
      input,
      buildUserFacingReply(objective),
      {
        summary: objective.slice(0, 240),
      },
      { latencyMs: 2, apiCalls: 1 },
    );
  }
}
