import type { AgentInvokeInputDTO } from '../../contracts';
import { classifyIntent } from '../../orchestration/intent/canonical-intent';
import { BaseAgent } from '../base';

export class RiskCheckAgent extends BaseAgent {
  readonly key = 'risk-check';

  async invoke(input: AgentInvokeInputDTO) {
    const intent = classifyIntent(input.objective);
    const risky = intent.isDestructive;

    return this.success(
      input,
      risky ? 'Potentially destructive intent detected' : 'No destructive intent detected',
      {
        risky,
        keywords: intent.matchedVerbs,
      },
      { latencyMs: 1, apiCalls: 1 },
    );
  }
}
