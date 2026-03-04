import type { AgentInvokeInputDTO } from '../../contracts';
import { BaseAgent } from '../base';

const RISK_KEYWORDS = ['delete', 'remove', 'drop', 'overwrite', 'destroy'];

export class RiskCheckAgent extends BaseAgent {
  readonly key = 'risk-check';

  async invoke(input: AgentInvokeInputDTO) {
    const normalized = input.objective.toLowerCase();
    const risky = RISK_KEYWORDS.some((keyword) => normalized.includes(keyword));

    return this.success(
      input,
      risky ? 'Potentially destructive intent detected' : 'No destructive intent detected',
      {
        risky,
        keywords: RISK_KEYWORDS.filter((keyword) => normalized.includes(keyword)),
      },
      { latencyMs: 1, apiCalls: 1 },
    );
  }
}
